import { TFile } from 'obsidian'
import type { App } from 'obsidian'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFakeApp } from '../../../test/fakeVault'
import { FakeAdapter, must, mutateMock, setDefaultMaps } from './test-harness'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, makeTask } from '../../types'
import type PMPlugin from '../../main'
import { ProjectStore } from '../../store/ProjectStore'
import { stopMockServer } from './JiraMockServer'
import { ensureProjectCfg, taskExt } from './types'
import { exportTasks, fetchEpicStories, importStories, runSync } from './sync'

/**
 * Drift guard: drive the JIRA connector through the REAL ProjectStore over the
 * in-memory vault (not the FakeStore). A behavioral change in the store —
 * saveProject no longer persisting fields, importTasks changing nesting, etc. —
 * fails here instead of silently breaking the plugin.
 */
describe('jira ↔ core store integration (real ProjectStore) [both]', () => {
  afterEach(() => stopMockServer())

  function realPlugin(team: string[] = []): { plugin: PMPlugin; store: ProjectStore; app: App } {
    const { app } = makeFakeApp()
    ;(app.vault as unknown as { adapter: FakeAdapter }).adapter = new FakeAdapter() // for jira-mock.json
    const settings = {
      statuses: DEFAULT_STATUSES,
      priorities: DEFAULT_PRIORITIES,
      globalTeamMembers: team,
      connectors: { jira: { servers: [{ id: 's1', name: 'Local', site: 'localhost', email: 'x' }] } },
      connectorSecrets: {}
    }
    const store = new ProjectStore(app as unknown as App, () => settings.statuses)
    const plugin = {
      app,
      manifest: { dir: 'plugins/pm' },
      settings,
      store,
      refreshProjectViews() {},
      saveSettings: () => Promise.resolve()
    } as unknown as PMPlugin
    return { plugin, store, app: app as unknown as App }
  }

  async function connected(plugin: PMPlugin, store: ProjectStore, team: string[] = []) {
    const project = await store.createProject('Demo', 'Projects')
    project.teamMembers = team
    const cfg = ensureProjectCfg(project)
    cfg.enabled = true
    cfg.serverId = 's1'
    cfg.epicId = 'DEMO-100'
    setDefaultMaps(cfg)
    return { project, cfg }
  }

  const reload = async (store: ProjectStore, app: App, path: string) => {
    const file = app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error(`project file missing: ${path}`)
    return must(await store.loadProject(file), 'reloaded project')
  }

  it('export persists the linked JIRA key to the task .md (round-trips from disk)', async () => {
    const { plugin, store, app } = realPlugin()
    const { project } = await connected(plugin, store)
    const t = makeTask({ title: 'Build widget' })
    await store.insertTask(project, t, null)

    await exportTasks(plugin, project, [t.id])
    expect(taskExt(must(project.tasks.find((x) => x.title === 'Build widget'))).key).toBeTruthy()

    // Re-read from the vault: the key must have been persisted by the real store.
    const reloaded = await reload(store, app, project.filePath)
    const rt = must(reloaded.tasks.find((x) => x.title === 'Build widget'))
    expect(taskExt(rt).key).toBeTruthy()
    expect(taskExt(rt).sync).toBe(true)
  })

  it('import persists nested subtasks and a new team member to disk', async () => {
    const { plugin, store, app } = realPlugin()
    const { project } = await connected(plugin, store)
    await runSync(plugin, project) // seed the local server + epic
    await mutateMock(plugin, (s) => {
      const story = s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Story' },
        summary: 'Story A',
        parent: { key: 'DEMO-100' }
      })
      s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Sub-task' },
        summary: 'Sub of A',
        parent: { key: story.key },
        assignee: { accountId: 'mock:carol', displayName: 'Carol' }
      })
    })

    const stories = await fetchEpicStories(plugin, project)
    await importStories(plugin, project, stories)

    const reloaded = await reload(store, app, project.filePath)
    const story = must(reloaded.tasks.find((x) => x.title === 'Story A'))
    expect(story.subtasks.map((s) => s.title)).toEqual(['Sub of A']) // hierarchy persisted
    expect(reloaded.teamMembers).toContain('Carol') // auto-created member persisted
  })
})
