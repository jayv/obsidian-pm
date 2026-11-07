import type { App } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp } from '../test/fakeVault'
import { PMApiError, PluginApi, type ChangeEvent } from './api'
import { stopMockServer } from './connectors/jira/JiraMockServer'
import { FakeAdapter, mutateMock, setDefaultMaps } from './connectors/jira/test-harness'
import { ensureProjectCfg, ensureTaskExt, taskExt } from './connectors/jira/types'
import type PMPlugin from './main'
import { ProjectStore } from './store/ProjectStore'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, makeTask, type Project } from './types'
import { openTaskModal } from './ui/ModalFactory'

vi.mock('./ui/ModalFactory', () => ({ openTaskModal: vi.fn<() => void>() }))

interface Ctx {
  plugin: PMPlugin
  store: ProjectStore
  api: PluginApi
  refreshed: () => number
  /** The ProjectView stub `router.openProjectView` hands back. */
  view: { revealTask: ReturnType<typeof vi.fn>; setView: ReturnType<typeof vi.fn> }
  opened: ReturnType<typeof vi.fn>
}

/** A plugin with a real store over a fake vault, wired the way main.ts wires it. */
function realPlugin(): Ctx {
  const { app } = makeFakeApp()
  ;(app.vault as unknown as { adapter: FakeAdapter }).adapter = new FakeAdapter() // jira-mock.json
  const refresh = vi.fn<() => void>()
  const view = { revealTask: vi.fn<() => Promise<boolean>>(async () => true), setView: vi.fn<() => void>() }
  const opened = vi.fn<() => Promise<typeof view>>(async () => view)
  const settings = {
    projectsFolder: 'Projects',
    statuses: DEFAULT_STATUSES,
    priorities: DEFAULT_PRIORITIES,
    globalTeamMembers: [],
    connectors: { jira: { servers: [{ id: 's1', name: 'Mock', site: 'localhost', email: 'x' }] } },
    connectorSecrets: {}
  }
  const store = new ProjectStore(app as unknown as App, () => settings.statuses)
  const plugin = {
    app,
    manifest: { dir: 'plugins/pm' },
    settings,
    store,
    refreshProjectViews: refresh,
    saveSettings: () => Promise.resolve(),
    router: { openProjectView: opened }
  } as unknown as PMPlugin
  const api = new PluginApi(plugin)
  store.onTaskChanged = (project, task) => api.noteTaskChanged(project, task)
  store.onProjectSaved = (project) => api.noteProjectSaved(project)
  return { plugin, store, api, refreshed: () => refresh.mock.calls.length, view, opened }
}

async function seeded() {
  const ctx = realPlugin()
  const project = await ctx.store.createProject('Alpha', 'Projects')
  const parent = makeTask({ title: 'Parent' })
  await ctx.store.insertTask(project, parent)
  const child = makeTask({ title: 'Child' })
  await ctx.store.insertTask(project, child, parent.id)
  return { ...ctx, project, parent, child }
}

/** A project bound to the in-process Jira mock, root DEMO-100. */
async function jiraProject(ctx: Ctx, title = 'Demo'): Promise<Project> {
  const project = await ctx.store.createProject(title, 'Projects')
  const cfg = ensureProjectCfg(project)
  cfg.enabled = true
  cfg.serverId = 's1'
  cfg.epicId = 'DEMO-100'
  setDefaultMaps(cfg)
  await ctx.store.saveProject(project)
  return project
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'resolved'
  } catch (e) {
    return e instanceof PMApiError ? e.code : `not a PMApiError: ${String(e)}`
  }
}

describe('PluginApi', () => {
  afterEach(() => stopMockServer())

  it('lists projects and tasks as snapshots with their vault paths', async () => {
    const { api, project, parent, child } = await seeded()

    expect(await api.listProjects()).toEqual([
      { id: project.id, title: 'Alpha', filePath: 'Projects/Alpha.md', taskCount: 2, jira: null }
    ])
    const tasks = await api.listTasks('Projects/Alpha')
    expect(tasks.map((t) => [t.title, t.parentId, t.filePath])).toEqual([
      ['Parent', null, parent.filePath],
      ['Child', parent.id, child.filePath]
    ])
    expect(tasks[0].subtaskIds).toEqual([child.id])
    expect(tasks[0].jira).toBeNull()
    expect(await api.listTasks('Projects/Nope')).toEqual([])
  })

  it('resolves a task by vault path, with or without .md, or by id', async () => {
    const { api, child } = await seeded()
    const path = child.filePath ?? ''

    expect((await api.getTask(path))?.id).toBe(child.id)
    expect((await api.getTask(path.replace(/\.md$/, '')))?.id).toBe(child.id)
    expect((await api.getTask(child.id))?.title).toBe('Child')
    expect(await api.getTask('Projects/Alpha_tasks/Missing.md')).toBeNull()
  })

  it('writes a validated patch through the store so the note is rewritten', async () => {
    const { api, plugin, child, refreshed } = await seeded()

    const after = await api.updateTask(child.id, {
      status: 'in-progress',
      due: '2026-12-01',
      assignees: [' Jo ', ''],
      progress: 40
    })

    expect(after).toMatchObject({ status: 'in-progress', due: '2026-12-01', assignees: ['Jo'], progress: 40 })
    expect(refreshed()).toBeGreaterThan(0)
    const file = plugin.app.vault.getAbstractFileByPath(child.filePath ?? '')
    const raw = await plugin.app.vault.read(file as never)
    expect(raw).toContain('status: "in-progress"')
    expect(raw).toContain('due: "2026-12-01"')
  })

  it('stamps completion when the patch moves the task to a complete status', async () => {
    const { api, child } = await seeded()
    const after = await api.updateTask(child.id, { status: 'done' })
    expect(after.completed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(after.progress).toBe(100)
  })

  it('rejects unknown fields and bad values with a code, without touching the task', async () => {
    const { api, child } = await seeded()

    expect(await code(api.updateTask(child.id, { subtaskIds: [] } as never))).toBe('invalid')
    await expect(api.updateTask(child.id, { status: 'In Progress' })).rejects.toThrow('status must be one of')
    expect(await code(api.updateTask(child.id, { priority: 'urgent' as never }))).toBe('invalid')
    expect(await code(api.updateTask(child.id, { due: '12/01/2026' }))).toBe('invalid')
    expect(await code(api.updateTask(child.id, { progress: 140 }))).toBe('invalid')
    expect(await code(api.updateTask(child.id, { title: '  ' }))).toBe('invalid')
    expect(await code(api.updateTask('nope', { title: 'x' }))).toBe('not-found')
    expect((await api.getTask(child.id))?.status).toBe('todo')
  })

  it('refuses to edit a task sitting in a Jira conflict', async () => {
    const { api, store, project, child } = await seeded()
    ensureTaskExt(child).key = 'DEMO-7'
    ensureTaskExt(child).reconciled = false
    await store.saveProject(project)

    expect(await code(api.updateTask(child.id, { title: 'x' }))).toBe('conflict')
    expect((await api.getTask(child.id))?.jira).toEqual({ key: 'DEMO-7', sync: false, conflict: true })
  })

  it('creates a task under a parent in the named project', async () => {
    const { api, parent, project } = await seeded()

    const made = await api.createTask('Projects/Alpha', { title: 'Grandchild', priority: 'high' }, parent.id)

    expect(made).toMatchObject({
      title: 'Grandchild',
      priority: 'high',
      parentId: parent.id,
      projectPath: project.filePath
    })
    expect((await api.getTask(parent.id))?.subtaskIds).toContain(made.id)
    expect(await code(api.createTask('Projects/Nope', { title: 'x' }))).toBe('not-found')
  })

  it('opts a new task into Jira sync in a connected project unless told not to', async () => {
    const ctx = realPlugin()
    const project = await jiraProject(ctx)
    expect((await ctx.api.listProjects()).find((p) => p.title === 'Demo')?.jira).toEqual({
      serverId: 's1',
      rootKey: 'DEMO-100'
    })

    const synced = await ctx.api.createTask(project.filePath, { title: 'Synced' })
    const local = await ctx.api.createTask(project.filePath, { title: 'Local' }, undefined, { sync: false })

    const find = (id: string) => project.tasks.find((t) => t.id === id) ?? makeTask()
    expect(taskExt(find(synced.id)).sync).toBe(true)
    expect(taskExt(find(local.id)).sync).toBeUndefined()
  })

  describe('openTask', () => {
    it("defaults to 'both': reveals the row in the project tab, then opens the editor", async () => {
      const { api, child, opened, view, project } = await seeded()

      expect(await api.openTask(child.filePath ?? '')).toBe(true)
      expect(opened).toHaveBeenCalledTimes(1)
      expect(view.revealTask).toHaveBeenCalledWith(child.id, undefined)
      expect(openTaskModal).toHaveBeenCalledWith(expect.anything(), project, expect.objectContaining({ task: child }))
    })

    it("'modal' skips the project tab; 'project' skips the editor; view is passed through", async () => {
      const { api, child, opened, view } = await seeded()
      vi.mocked(openTaskModal).mockClear()

      await api.openTask(child.id, { where: 'modal' })
      expect(opened).not.toHaveBeenCalled()
      expect(openTaskModal).toHaveBeenCalledTimes(1)

      await api.openTask(child.id, { where: 'project', view: 'gantt' })
      expect(view.revealTask).toHaveBeenCalledWith(child.id, 'gantt')
      expect(openTaskModal).toHaveBeenCalledTimes(1)
    })

    it('reports an unknown ref without opening anything', async () => {
      const { api, opened } = await seeded()
      expect(await api.openTask('Projects/Alpha_tasks/Missing')).toBe(false)
      expect(opened).not.toHaveBeenCalled()
    })

    it('openProject reveals the tab and can switch the sub-view', async () => {
      const { api, view } = await seeded()
      expect(await api.openProject('Projects/Alpha', { view: 'kanban' })).toBe(true)
      expect(view.setView).toHaveBeenCalledWith('kanban')
      expect(await api.openProject('Projects/Nope')).toBe(false)
    })
  })

  describe('onChange', () => {
    it('emits one task event per changed task after the save, and can unsubscribe', async () => {
      const { api, child } = await seeded()
      const seen: ChangeEvent[] = []
      const off = api.onChange((e) => seen.push(e))

      await api.updateTask(child.id, { title: 'Renamed' })
      expect(seen).toEqual([{ kind: 'task', projectPath: 'Projects/Alpha.md', taskId: child.id }])

      off()
      await api.updateTask(child.id, { title: 'Again' })
      expect(seen).toHaveLength(1)
    })

    it('survives a throwing listener', async () => {
      const { api, child } = await seeded()
      const ok = vi.fn<() => void>()
      api.onChange(() => {
        throw new Error('boom')
      })
      api.onChange(ok)
      await api.updateTask(child.id, { title: 'x' })
      expect(ok).toHaveBeenCalled()
    })
  })

  describe('importJiraIssue', () => {
    /** Story A under the root, a Sub-task under it, and a parentless stray. */
    async function withIssues(ctx: Ctx) {
      const project = await jiraProject(ctx)
      const keys = { story: '', sub: '', stray: '' }
      await mutateMock(ctx.plugin, (s) => {
        const a = s.createIssue({
          project: { key: 'DEMO' },
          issuetype: { name: 'Story' },
          summary: 'Story A',
          parent: { key: 'DEMO-100' }
        })
        keys.story = a.key
        keys.sub = s.createIssue({
          project: { key: 'DEMO' },
          issuetype: { name: 'Sub-task' },
          summary: 'Sub of A',
          parent: { key: a.key }
        }).key
        keys.stray = s.createIssue({ project: { key: 'DEMO' }, issuetype: { name: 'Story' }, summary: 'Elsewhere' }).key
      })
      return { project, ...keys }
    }

    it('imports an issue as a linked task and is idempotent', async () => {
      const ctx = realPlugin()
      const { project, story } = await withIssues(ctx)

      const first = await ctx.api.importJiraIssue(story.toLowerCase())
      expect(first.created).toBe(true)
      expect(first.task).toMatchObject({
        title: 'Story A',
        parentId: null,
        projectPath: project.filePath,
        jira: { key: story, sync: true, conflict: false }
      })

      const again = await ctx.api.importJiraIssue(story, { projectPath: project.filePath })
      expect(again.created).toBe(false)
      expect(again.task.id).toBe(first.task.id)
      expect((await ctx.api.listTasks(project.filePath)).filter((t) => t.jira?.key === story)).toHaveLength(1)
    })

    it("nests under the issue's own Jira parent when that parent is a local task", async () => {
      const ctx = realPlugin()
      const { story, sub } = await withIssues(ctx)
      const parent = await ctx.api.importJiraIssue(story)
      const child = await ctx.api.importJiraIssue(sub)
      expect(child.task.parentId).toBe(parent.task.id)
    })

    it('places the task under a requested parent instead', async () => {
      const ctx = realPlugin()
      const { project, story } = await withIssues(ctx)
      const local = await ctx.api.createTask(project.filePath, { title: 'Local parent' }, undefined, { sync: false })

      const made = await ctx.api.importJiraIssue(story, { parent: local.id })
      expect(made.task.parentId).toBe(local.id)
      expect((await ctx.api.getTask(local.id))?.subtaskIds).toEqual([made.task.id])
    })

    it('refuses to nest below a Sub-task', async () => {
      const ctx = realPlugin()
      const { story, sub } = await withIssues(ctx)
      await ctx.api.importJiraIssue(story)
      const leaf = await ctx.api.importJiraIssue(sub)
      let other = ''
      await mutateMock(ctx.plugin, (s) => {
        other = s.createIssue({
          project: { key: 'DEMO' },
          issuetype: { name: 'Story' },
          summary: 'Story B',
          parent: { key: 'DEMO-100' }
        }).key
      })
      expect(await code(ctx.api.importJiraIssue(other, { parent: leaf.task.id }))).toBe('too-deep')
    })

    it('codes the failure modes: bad key, no Jira, unknown issue, outside the root', async () => {
      const ctx = realPlugin()
      const { project, stray } = await withIssues(ctx)
      await ctx.store.createProject('Plain', 'Projects')

      expect(await code(ctx.api.importJiraIssue('not a key'))).toBe('invalid')
      expect(await code(ctx.api.importJiraIssue('DEMO-1', { projectPath: 'Projects/Plain' }))).toBe('jira-disabled')
      expect(await code(ctx.api.importJiraIssue('DEMO-99999'))).toBe('not-found')
      expect(await code(ctx.api.importJiraIssue(stray, { projectPath: project.filePath }))).toBe('out-of-scope')
      expect(await code(ctx.api.importJiraIssue(stray))).toBe('not-found')
    })
  })

  it('syncProject runs a full sync and reports what it did', async () => {
    const ctx = realPlugin()
    const project = await jiraProject(ctx)
    await mutateMock(ctx.plugin, (s) => {
      s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Story' },
        summary: 'New',
        parent: { key: 'DEMO-100' }
      })
    })
    await ctx.api.createTask(project.filePath, { title: 'Push me' })

    const r = await ctx.api.syncProject(project.filePath)
    expect(r.jiraCreated).toBe(1)
    expect(r.newIssues).toHaveLength(1)
    expect(r.conflicts).toBe(0)
    expect(await code(ctx.api.syncProject('Projects/Alpha'))).toBe('not-found')
  })
})
