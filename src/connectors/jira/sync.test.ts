import { afterEach, describe, expect, it } from 'vitest'
import { findTask, flattenTasks } from '../../store/TaskTreeOps'
import {
  FUTURE,
  FakeAdapter,
  connect,
  harness,
  localTask,
  must,
  mustIssue,
  mutateMock,
  optIn,
  readMock,
  rewind,
  seedChain,
  setDefaultMaps,
  sharedMap,
  statusObj
} from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { adfToMarkdown, markdownToAdf } from './adf'
import { canonicalDescription } from './reconcile'
import { CONFIG_PROP, ISSUE_PROP, taskExt, type JiraEpicConfig, type JiraIssueProps } from './types'
import {
  exportTasks,
  exportableTasks,
  fetchEpicStories,
  importStories,
  loadMappingValues,
  makeClient,
  resolveConflict,
  runSync,
  searchJiraUsers,
  updateIgnoredKeys
} from './sync'
import type { JiraClient } from './JiraClient'

// Each test gets a fresh in-process server bound to its plugin/vault.
afterEach(() => stopMockServer())

const EPIC = 'DEMO-100'

describe('jira sync — setup & metadata [setup]', () => {
  it('seeds mock meta from settings + creates the epic issue on first sync', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const mock = await readMock(plugin)
    expect(mock.data.meta.statuses.map((s) => s.name)).toContain('In Progress')
    expect(mock.data.meta.priorities.map((p) => p.name)).toContain('Critical')
    expect(mock.data.meta.users.map((u) => u.accountId)).toContain('mock:alice')
    const epic = mustIssue(mock, EPIC)
    expect(epic.fields.summary).toBe('Demo Project')
    expect((epic.fields.issuetype as { name: string }).name).toBe('Epic')
  })

  it('loadMappingValues prefills status + priority maps and marks them dirty', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    const { statusesAdded, prioritiesAdded } = await loadMappingValues(plugin, project)
    expect(statusesAdded).toBeGreaterThan(0)
    expect(prioritiesAdded).toBeGreaterThan(0)
    expect(cfg.statusMap.some((e) => e.jira === 'In Progress')).toBe(true)
    expect(cfg.priorityMap.some((e) => e.jira === 'High')).toBe(true)
    expect(cfg.mappingsDirty).toBe(true)
  })

  // Status and priority maps are project configuration and worth sharing. Assignee
  // mappings are name↔accountId pairs, and there's no reason to put those in Jira — so
  // they stay local, and a second user maps their own people.
  it('never publishes assignee mappings to the epic config', async () => {
    const shared = new FakeAdapter()
    const a = harness({ adapter: shared, team: ['Alice', 'Bob'] })
    const projA = connect(a.plugin, { team: ['Alice', 'Bob'] })
    setDefaultMaps(projA.cfg)
    projA.cfg.assigneeMap = [
      { name: 'Alice', jiraUser: 'mock:alice' },
      { name: 'Bob', jiraUser: 'mock:bob' }
    ]
    projA.cfg.mappingsDirty = true
    await runSync(a.plugin, projA.project)

    const published = (await readMock(a.plugin)).getProperty(EPIC, CONFIG_PROP) as Record<string, unknown>
    expect(published.statusMap).toBeDefined() // the shareable half still goes
    expect(published.assigneeMap).toBeUndefined()
    expect(JSON.stringify(published)).not.toContain('mock:alice')
    stopMockServer()

    // A second user reading that config inherits the value maps and nobody's identity.
    const b = harness({ adapter: shared })
    const projB = connect(b.plugin)
    await loadMappingValues(b.plugin, projB.project)
    expect(sharedMap(b.plugin)).toEqual([])
    expect(projB.project.teamMembers).toEqual([])
  })

  it('userPicker autocompletes assignees by query', async () => {
    const { plugin } = harness({ team: ['Alice', 'Bob'] })
    const { project } = connect(plugin, { team: ['Alice', 'Bob'] })
    await runSync(plugin, project) // seed users
    const hits = await searchJiraUsers(plugin, project, 'bob')
    expect(hits.map((u) => u.accountId)).toEqual(['mock:bob'])
  })
})

describe('jira sync — export (Obsidian → JIRA) [O→J]', () => {
  it('exportableTasks lists only keyless tasks', () => {
    const { plugin } = harness()
    const { project } = connect(plugin)
    void plugin
    const a = localTask(project, { title: 'A' })
    localTask(project, { title: 'B' })
    a.ext = { jira: { key: 'DEMO-9' } }
    expect(exportableTasks(project).map((t) => t.title)).toEqual(['B'])
  })

  it('creates issues parent-first and links tasks back with key + sync', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]
    const parent = localTask(project, { title: 'Parent', status: 'in-progress', priority: 'high', due: '2026-07-01' })
    const child = localTask(project, { title: 'Child', assignees: ['Alice'] }, parent.id)

    const { created } = await exportTasks(plugin, project, [parent.id, child.id])
    expect(created).toBe(2)

    const pKey = taskExt(parent).key ?? ''
    const cKey = taskExt(child).key ?? ''
    expect(pKey).toBeTruthy()
    expect(taskExt(parent).sync).toBe(true)

    const mock = await readMock(plugin)
    const p = mustIssue(mock, pKey)
    // Child of an Epic (level 1) → a level-0 type; Task is preferred over Story.
    expect((p.fields.issuetype as { name: string }).name).toBe('Task')
    expect((p.fields.parent as { key: string }).key).toBe(EPIC)
    expect((p.fields.status as { name: string }).name).toBe('In Progress') // via transition
    expect((p.fields.priority as { name: string }).name).toBe('High')
    expect(p.fields.duedate).toBe('2026-07-01')

    const c = mustIssue(mock, cKey)
    expect((c.fields.issuetype as { name: string }).name).toBe('Sub-task')
    expect((c.fields.parent as { key: string }).key).toBe(pKey)
    expect((c.fields.assignee as { accountId: string }).accountId).toBe('mock:alice')
  })

  const typeName = (mock: Awaited<ReturnType<typeof readMock>>, key: string): string =>
    (mustIssue(mock, key).fields.issuetype as { name: string }).name

  it('creates each level one type below its parent (Epic root → Task → Sub-task), skipping too-deep', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    // A > B > C under the epic (seeded as an Epic, level 1).
    const a = localTask(project, { title: 'A' })
    const b = localTask(project, { title: 'B' }, a.id)
    const c = localTask(project, { title: 'C' }, b.id)

    const { created, skipped } = await exportTasks(plugin, project, [a.id, b.id, c.id])
    expect(created).toBe(2)
    expect(skipped).toEqual(['C']) // child of a Sub-task is below Jira's floor

    const mock = await readMock(plugin)
    expect(typeName(mock, must(taskExt(a).key))).toBe('Task') // child of Epic
    expect(typeName(mock, must(taskExt(b).key))).toBe('Sub-task') // child of Task
    expect(taskExt(c).key).toBeFalsy() // too deep — not created
  })

  it('uses the configured root issue type as the top (Initiative → Epic → Task → Sub-task)', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seed the epic issue
    await mutateMock(plugin, (s) => {
      const root = s.getIssue(EPIC)
      if (root) root.fields.issuetype = { name: 'Initiative' } // make the root an Initiative (level 2)
    })

    const a = localTask(project, { title: 'A' })
    const b = localTask(project, { title: 'B' }, a.id)
    const c = localTask(project, { title: 'C' }, b.id)
    const { created, skipped } = await exportTasks(plugin, project, [a.id, b.id, c.id])
    expect(created).toBe(3)
    expect(skipped).toEqual([])

    const mock = await readMock(plugin)
    expect(typeName(mock, must(taskExt(a).key))).toBe('Epic') // child of Initiative
    expect(typeName(mock, must(taskExt(b).key))).toBe('Task') // child of Epic
    expect(typeName(mock, must(taskExt(c).key))).toBe('Sub-task') // child of Task
  })

  it('writes the milestone flag to the issue property bag', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const ms = localTask(project, { title: 'Cut-off', type: 'milestone' })
    await exportTasks(plugin, project, [ms.id])
    const mock = await readMock(plugin)
    expect((mock.getProperty(taskExt(ms).key ?? '', ISSUE_PROP) as JiraIssueProps).milestone).toBe(true)
  })

  it('writes a dependency as an "is blocked by" link', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const blocker = localTask(project, { title: 'B' })
    const blocked = localTask(project, { title: 'A' })
    blocked.dependencies = [blocker.id]
    await exportTasks(plugin, project, [blocker.id, blocked.id])
    const mock = await readMock(plugin)
    const blockedKey = taskExt(blocked).key ?? ''
    const blockerKey = taskExt(blocker).key ?? ''
    const links = mustIssue(mock, blockedKey).fields.issuelinks as { inwardIssue?: { key: string } }[]
    expect(links.some((l) => l.inwardIssue?.key === blockerKey)).toBe(true)
  })
})

describe('jira sync — import (JIRA → Obsidian) [J→O]', () => {
  // Populate the mock with epic children (a teammate's issues), then import.
  async function seedRemoteIssues(plugin: ReturnType<typeof harness>['plugin']): Promise<void> {
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seed meta + epic
    await mutateMock(plugin, (s) => {
      const story = s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Story' },
        summary: 'Story A',
        parent: { key: EPIC },
        priority: { name: 'High' }
      })
      const sub = s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Sub-task' },
        summary: 'Sub of A',
        parent: { key: story.key },
        assignee: { accountId: 'mock:alice', displayName: 'Alice' }
      })
      s.setProperty(sub.key, ISSUE_PROP, { milestone: false })
    })
  }

  it('creates tasks for epic children + subtasks, nested', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    await seedRemoteIssues(plugin)
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    const stories = await fetchEpicStories(plugin, project)
    const { created } = await importStories(plugin, project, stories)
    expect(created).toBe(2)

    const story = project.tasks.find((t) => t.title === 'Story A')
    expect(story).toBeTruthy()
    expect(story?.priority).toBe('high')
    expect(story?.subtasks.map((s) => s.title)).toEqual(['Sub of A'])
    expect(story?.subtasks[0].assignees).toEqual(['Alice'])
  })

  it('crawls + imports a deep parent chain (epic → L1 → L2 → L3 → L4), nested at every level', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seed meta + epic
    // A 4-level chain under the epic — each issue's parent is the one above it.
    await seedChain(plugin, EPIC, ['L1', 'L2', 'L3', 'L4'])

    // The crawl descends every level (not just the epic's direct child), in O(depth).
    const stories = await fetchEpicStories(plugin, project)
    expect(stories.map((s) => s.summary).sort()).toEqual(['L1', 'L2', 'L3', 'L4'])

    const { created } = await importStories(plugin, project, stories)
    expect(created).toBe(4)

    // Each level nests under the previous via `parent` (no Jira Sub-task type needed).
    const l1 = project.tasks.find((t) => t.title === 'L1')
    const l2 = l1?.subtasks.find((t) => t.title === 'L2')
    const l3 = l2?.subtasks.find((t) => t.title === 'L3')
    expect(l3?.subtasks.map((t) => t.title)).toEqual(['L4'])
  })

  it('auto-creates an unknown assignee as a project team member during import', async () => {
    const { plugin } = harness() // no team configured locally
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seed meta + epic
    await mutateMock(plugin, (s) => {
      s.registerUser('mock:dana', 'Dana')
      s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Story' },
        summary: 'Owned by Dana',
        parent: { key: EPIC },
        assignee: { accountId: 'mock:dana', displayName: 'Dana' }
      })
    })
    const stories = await fetchEpicStories(plugin, project)
    await importStories(plugin, project, stories)

    const t = project.tasks.find((x) => x.title === 'Owned by Dana')
    expect(t?.assignees).toEqual(['Dana'])
    expect(project.teamMembers).toContain('Dana') // new project member
    expect(sharedMap(plugin).some((e) => e.name === 'Dana' && e.jiraUser === 'mock:dana')).toBe(true)
  })

  it('adds assignees to team members even when the mapping is adopted from the epic config', async () => {
    // Vault A publishes an assignee mapping to the epic; vault B imports into an empty team.
    const shared = new FakeAdapter()
    const a = harness({ adapter: shared, team: ['Alice'] })
    const projA = connect(a.plugin, { team: ['Alice'] })
    setDefaultMaps(projA.cfg)
    projA.cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]
    projA.cfg.mappingsDirty = true
    await runSync(a.plugin, projA.project) // publishes assigneeMap to the epic
    await mutateMock(a.plugin, (s) => {
      s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Story' },
        summary: 'For Alice',
        parent: { key: EPIC },
        assignee: { accountId: 'mock:alice', displayName: 'Alice' }
      })
    })
    stopMockServer()

    const b = harness({ adapter: shared }) // empty team locally
    const projB = connect(b.plugin)
    const stories = await fetchEpicStories(b.plugin, projB.project)
    await importStories(b.plugin, projB.project, stories) // pulls epic config (found mapping) then resolves

    expect(sharedMap(b.plugin).some((e) => e.name === 'Alice')).toBe(true) // mapping adopted
    expect(projB.project.teamMembers).toContain('Alice') // and the member is created
  })

  it('wires dependencies from blockedBy links', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    let aKey = ''
    let bKey = ''
    await mutateMock(plugin, (s) => {
      const a = s.createIssue({ issuetype: { name: 'Story' }, summary: 'A', parent: { key: EPIC } })
      const b = s.createIssue({ issuetype: { name: 'Story' }, summary: 'B', parent: { key: EPIC } })
      aKey = a.key
      bKey = b.key
      s.addBlockLink(a.key, b.key) // A is blocked by B
    })
    const stories = await fetchEpicStories(plugin, project)
    await importStories(plugin, project, stories)
    const a = project.tasks.find((t) => t.title === 'A')
    const b = project.tasks.find((t) => t.title === 'B')
    expect(a?.dependencies).toEqual([b?.id])
    void aKey
    void bKey
  })

  it('skips already-imported and ignored keys', async () => {
    const { plugin } = harness()
    await seedRemoteIssues(plugin)
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const stories = await fetchEpicStories(plugin, project)
    cfg.ignoredKeys = stories.map((s) => s.key) // ignore them all
    const { created } = await importStories(plugin, project, [])
    expect(created).toBe(0)
    // Re-import after un-ignoring once: imports, then a second import is a no-op.
    const first = await importStories(plugin, project, stories)
    expect(first.created).toBeGreaterThan(0)
    const second = await importStories(plugin, project, stories)
    expect(second.created).toBe(0)
  })

  it('pulls the epic config first and adopts custom mapping targets', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seed epic
    // A teammate published a config that maps "In Review" → done (custom).
    await mutateMock(plugin, (s) => {
      s.setProperty(EPIC, CONFIG_PROP, {
        statusMap: [{ jira: 'In Review', target: 'done', outbound: true }],
        priorityMap: []
      } satisfies JiraEpicConfig)
    })
    const fresh = connect(plugin) // a different project, empty maps
    await loadMappingValues(plugin, fresh.project)
    expect(fresh.cfg.statusMap.some((e) => e.jira === 'In Review' && e.target === 'done')).toBe(true)
  })
})

describe('jira sync — outbound dirty push [O→J]', () => {
  async function exportOne(
    plugin: ReturnType<typeof harness>['plugin'],
    overrides = {}
  ): Promise<{
    project: ReturnType<typeof connect>['project']
    cfg: ReturnType<typeof connect>['cfg']
    task: ReturnType<typeof localTask>
  }> {
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]
    const task = localTask(project, { title: 'T', status: 'todo', ...overrides })
    await exportTasks(plugin, project, [task.id])
    return { project, cfg, task }
  }

  it('pushes summary, due, priority and a status transition for a dirty task', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg, task } = await exportOne(plugin)
    task.title = 'T renamed'
    task.due = '2026-08-08'
    task.priority = 'critical'
    task.status = 'in-progress'
    cfg.dirtyQueue = [task.id]
    await runSync(plugin, project)

    const issue = mustIssue(await readMock(plugin), taskExt(task).key ?? '')
    expect(issue.fields.summary).toBe('T renamed')
    expect(issue.fields.duedate).toBe('2026-08-08')
    expect((issue.fields.priority as { name: string }).name).toBe('Critical')
    expect((issue.fields.status as { name: string }).name).toBe('In Progress')
  })

  it('updates the milestone property on push', async () => {
    const { plugin } = harness()
    const { project, cfg, task } = await exportOne(plugin)
    task.type = 'milestone'
    cfg.dirtyQueue = [task.id]
    await runSync(plugin, project)
    const mock = await readMock(plugin)
    expect((mock.getProperty(taskExt(task).key ?? '', ISSUE_PROP) as JiraIssueProps).milestone).toBe(true)
  })

  it('pushes an assignee change and a later unassign', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg, task } = await exportOne(plugin)
    const key = taskExt(task).key ?? ''
    task.assignees = ['Alice']
    cfg.dirtyQueue = [task.id]
    await runSync(plugin, project)
    expect((mustIssue(await readMock(plugin), key).fields.assignee as { accountId: string }).accountId).toBe(
      'mock:alice'
    )

    task.assignees = []
    cfg.dirtyQueue = [task.id]
    await runSync(plugin, project)
    expect(mustIssue(await readMock(plugin), key).fields.assignee).toBeNull()
  })

  it('pushes a start-date change to the discovered custom field', async () => {
    const { plugin } = harness()
    const { project, cfg, task } = await exportOne(plugin)
    task.start = '2026-05-05'
    cfg.dirtyQueue = [task.id]
    await runSync(plugin, project)
    const mock = await readMock(plugin)
    expect(mustIssue(mock, taskExt(task).key ?? '').fields[mock.startFieldId]).toBe('2026-05-05')
  })

  it('clears the milestone flag when toggled off', async () => {
    const { plugin } = harness()
    const { project, cfg, task } = await exportOne(plugin)
    task.type = 'milestone'
    cfg.dirtyQueue = [task.id]
    await runSync(plugin, project)
    task.type = 'task'
    cfg.dirtyQueue = [task.id]
    await runSync(plugin, project)
    const mock = await readMock(plugin)
    expect((mock.getProperty(taskExt(task).key ?? '', ISSUE_PROP) as JiraIssueProps).milestone).toBe(false)
  })

  it('adds and removes dependency links two-way on push', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const a = localTask(project, { title: 'A' })
    const b = localTask(project, { title: 'B' })
    await exportTasks(plugin, project, [a.id, b.id])
    const aKey = taskExt(a).key ?? ''
    const bKey = taskExt(b).key ?? ''

    const linksOf = async (): Promise<{ inwardIssue?: { key: string } }[]> =>
      (mustIssue(await readMock(plugin), aKey).fields.issuelinks as { inwardIssue?: { key: string } }[]) ?? []

    // Add A → blocked by B.
    a.dependencies = [b.id]
    cfg.dirtyQueue = [a.id]
    await runSync(plugin, project)
    expect((await linksOf()).some((l) => l.inwardIssue?.key === bKey)).toBe(true)

    // Remove the dependency → link deleted.
    a.dependencies = []
    cfg.dirtyQueue = [a.id]
    await runSync(plugin, project)
    expect((await linksOf()).some((l) => l.inwardIssue?.key === bKey)).toBe(false)
  })

  it('only creates opted-in keyless tasks (sync === true)', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    optIn(localTask(project, { title: 'opted' }))
    localTask(project, { title: 'not opted' }) // no sync flag
    const r = await runSync(plugin, project)
    expect(r.jiraCreated).toBe(1)
    const summaries = Object.values((await readMock(plugin)).data.issues).map((i) => i.fields.summary)
    expect(summaries).toContain('opted')
    expect(summaries).not.toContain('not opted')
  })
})

describe('jira sync — inbound reconcile [J→O]', () => {
  async function importedTask(
    plugin: ReturnType<typeof harness>['plugin']
  ): Promise<{ project: ReturnType<typeof connect>['project']; cfg: ReturnType<typeof connect>['cfg']; key: string }> {
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const t = localTask(project, { title: 'T', status: 'todo' })
    await exportTasks(plugin, project, [t.id])
    await runSync(plugin, project) // establish watermark
    return { project, cfg, key: taskExt(t).key ?? '' }
  }

  it('adopts a teammate status change (JIRA wins when not locally changed)', async () => {
    const { plugin } = harness()
    const { project, key } = await importedTask(plugin)
    await mutateMock(plugin, (s) => {
      const i = s.getIssue(key)
      if (i) {
        i.fields.status = statusObj('Done', 'Done')
        i.fields.updated = FUTURE
      }
    })
    await runSync(plugin, project)
    const t = must(findTask(project.tasks, flattenTasks(project.tasks)[0].task.id))
    expect(t.status).toBe('done')
    expect(taskExt(t).reconciled).toBeUndefined() // in sync, no limbo flag
  })

  it('flags limbo when local diverges and JIRA has no outbound mapping for it', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    // A map with NO "done" target (so the epic config never carries it either) —
    // a local "done" then has no outbound JIRA value, like a workflow gap.
    cfg.statusMap = [
      { jira: 'To Do', target: 'todo', outbound: true },
      { jira: 'In Progress', target: 'in-progress', outbound: true }
    ]
    cfg.priorityMap = [{ jira: 'Medium', target: 'medium', outbound: true }]
    const t = localTask(project, { title: 'T', status: 'todo' })
    await exportTasks(plugin, project, [t.id]) // JIRA status: To Do
    await runSync(plugin, project) // watermark + epic config (no "done")

    // Local user moves it to done; JIRA can't represent that → limbo.
    t.status = 'done'
    cfg.dirtyQueue = [t.id]
    // The dirty edit bumps `updated`; pin the watermark back to force re-examination.
    cfg.lastSeenUpdated = '2000-01-01T00:00:00.000+0000'
    await runSync(plugin, project)

    const after = must(findTask(project.tasks, t.id))
    expect(after.status).toBe('done') // keeps local
    expect(taskExt(after).reconciled).toBe(false) // surfaced as a conflict for the UI
  })

  it('adopts JIRA links inbound and clears a removed dependency', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const a = localTask(project, { title: 'A' })
    const b = localTask(project, { title: 'B' })
    await exportTasks(plugin, project, [a.id, b.id])
    await runSync(plugin, project)
    const aKey = taskExt(a).key ?? ''
    const bKey = taskExt(b).key ?? ''

    // Teammate links A → blocked by B in JIRA.
    await mutateMock(plugin, (s) => {
      s.addBlockLink(aKey, bKey)
      const i = s.getIssue(aKey)
      if (i) i.fields.updated = FUTURE
    })
    await runSync(plugin, project)
    expect(findTask(project.tasks, a.id)?.dependencies).toEqual([b.id])

    // Teammate removes the link.
    await mutateMock(plugin, (s) => {
      const links = mustIssue(s, aKey).fields.issuelinks as { id: string }[]
      s.removeLink(links[0].id)
      mustIssue(s, aKey).fields.updated = '2099-02-02T00:00:00.000+0000'
    })
    await runSync(plugin, project)
    expect(findTask(project.tasks, a.id)?.dependencies).toEqual([])
  })

  it('advances the watermark and skips unchanged issues', async () => {
    const { plugin } = harness()
    const { project, cfg, key } = await importedTask(plugin)
    const watermark = cfg.lastSeenUpdated
    expect(watermark).toBeTruthy()
    const r = await runSync(plugin, project) // nothing changed
    expect(r.changed).toBe(false)
    expect(cfg.lastSeenUpdated).toBe(watermark)
    void key
  })
})

describe('jira sync — assignees [both]', () => {
  it('resolves a known assignee mapping inbound', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]
    await runSync(plugin, project)
    await mutateMock(plugin, (s) => {
      s.createIssue({
        issuetype: { name: 'Story' },
        summary: 'Assigned',
        parent: { key: EPIC },
        assignee: { accountId: 'mock:alice', displayName: 'Alice' }
      })
    })
    const stories = await fetchEpicStories(plugin, project)
    await importStories(plugin, project, stories)
    expect(project.tasks.find((t) => t.title === 'Assigned')?.assignees).toEqual(['Alice'])
  })

  it('auto-creates an unknown assignee (member + mapping), keeping the mapping out of Jira', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    await mutateMock(plugin, (s) => {
      s.registerUser('mock:carol', 'Carol')
      const i = s.createIssue({
        issuetype: { name: 'Story' },
        summary: 'Mystery',
        parent: { key: EPIC },
        assignee: { accountId: 'mock:carol', displayName: 'Carol' }
      })
      i.fields.updated = FUTURE
    })
    const stories = await fetchEpicStories(plugin, project)
    await importStories(plugin, project, stories)

    expect(project.teamMembers).toContain('Carol')
    expect(sharedMap(plugin).some((e) => e.name === 'Carol' && e.jiraUser === 'mock:carol')).toBe(true)

    // The mapping is ours alone — the next sync must not carry Carol into Jira.
    await runSync(plugin, project)
    const epicCfg = (await readMock(plugin)).getProperty(EPIC, CONFIG_PROP) as Record<string, unknown>
    expect(JSON.stringify(epicCfg)).not.toContain('Carol')
  })
})

describe('jira sync — epic config sharing (multi-user) [both]', () => {
  it('publishes dirty maps to the epic config property', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    cfg.mappingsDirty = true
    await runSync(plugin, project)
    const epicCfg = (await readMock(plugin)).getProperty(EPIC, CONFIG_PROP) as JiraEpicConfig
    expect(epicCfg.statusMap.some((e) => e.jira === 'In Progress')).toBe(true)
  })

  it('merging a conflicting epic config does not create duplicate JIRA-status rules', async () => {
    const shared = new FakeAdapter()
    const a = harness({ adapter: shared })
    const projA = connect(a.plugin)
    projA.cfg.statusMap = [{ jira: 'Blocked', target: 'blocked', outbound: true }]
    projA.cfg.mappingsDirty = true
    await runSync(a.plugin, projA.project) // publishes Blocked→blocked to the epic
    stopMockServer()

    const b = harness({ adapter: shared })
    const projB = connect(b.plugin)
    projB.cfg.statusMap = [{ jira: 'Blocked', target: 'todo', outbound: true }] // conflicting local rule
    await loadMappingValues(b.plugin, projB.project)
    expect(projB.cfg.statusMap.filter((e) => e.jira === 'Blocked')).toHaveLength(1)
  })

  it("a second vault on the same epic adopts the first vault's maps without clobber", async () => {
    const shared = new FakeAdapter()
    const a = harness({ adapter: shared })
    const projA = connect(a.plugin)
    setDefaultMaps(projA.cfg)
    projA.cfg.mappingsDirty = true
    await runSync(a.plugin, projA.project)
    stopMockServer()

    const b = harness({ adapter: shared }) // same JIRA data
    const projB = connect(b.plugin)
    projB.cfg.statusMap = [{ jira: 'Custom', target: 'todo', outbound: true }] // a local-only rule
    await loadMappingValues(b.plugin, projB.project)
    // Adopted A's rules…
    expect(projB.cfg.statusMap.some((e) => e.jira === 'In Progress')).toBe(true)
    // …and kept its own.
    expect(projB.cfg.statusMap.some((e) => e.jira === 'Custom')).toBe(true)
  })
})

describe('jira sync — result stats [both]', () => {
  it('reports a created/updated/members/conflicts breakdown', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const t = optIn(localTask(project, { title: 'T', status: 'todo' }))
    const r1 = await runSync(plugin, project)
    expect(r1.jiraCreated).toBe(1)

    // A teammate edits the issue and assigns a brand-new user.
    await mutateMock(plugin, (s) => {
      const issue = mustIssue(s, taskExt(t).key ?? '')
      issue.fields.summary = 'T edited in Jira'
      issue.fields.assignee = { accountId: 'mock:dana', displayName: 'Dana' }
      issue.fields.updated = FUTURE
    })
    const r2 = await runSync(plugin, project)
    expect(r2.obsidianUpdated).toBe(1)
    expect(r2.membersAdded).toBe(1)
    expect(r2.conflicts).toBe(0)
  })
})

describe('jira sync — new-issue detection [J→O]', () => {
  it('surfaces new epic issues and excludes ignored ones', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    await mutateMock(plugin, (s) => {
      const keep = s.createIssue({ issuetype: { name: 'Story' }, summary: 'Keep', parent: { key: EPIC } })
      const skip = s.createIssue({ issuetype: { name: 'Story' }, summary: 'Skip', parent: { key: EPIC } })
      keep.fields.updated = FUTURE
      skip.fields.updated = FUTURE
      cfg.ignoredKeys = [skip.key]
    })
    const r = await runSync(plugin, project)
    expect(r.newIssues.map((i) => i.summary)).toEqual(['Keep'])
  })

  it('updateIgnoredKeys adds, removes, and no-ops without duplicating', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    cfg.ignoredKeys = ['A', 'B']

    await updateIgnoredKeys(plugin, project, { add: ['B', 'C'], remove: ['A'] }) // B already present
    expect(new Set(cfg.ignoredKeys)).toEqual(new Set(['B', 'C']))

    await updateIgnoredKeys(plugin, project, { remove: ['A'] }) // not present → no-op, no dup
    expect(new Set(cfg.ignoredKeys)).toEqual(new Set(['B', 'C']))
  })
})

describe('jira sync — milestone & end-to-end [both]', () => {
  it('round-trips a milestone export → import', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const ms = localTask(project, { title: 'Release', type: 'milestone' })
    await exportTasks(plugin, project, [ms.id])

    const fresh = connect(plugin)
    setDefaultMaps(fresh.cfg)
    const stories = await fetchEpicStories(plugin, fresh.project)
    await importStories(plugin, fresh.project, stories)
    expect(fresh.project.tasks.find((t) => t.title === 'Release')?.type).toBe('milestone')
  })

  it('full export (vault A) → import (vault B): hierarchy, deps, assignees', async () => {
    const shared = new FakeAdapter()
    const a = harness({ adapter: shared, team: ['Alice'] })
    const projA = connect(a.plugin, { team: ['Alice'] })
    setDefaultMaps(projA.cfg)
    projA.cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]
    projA.cfg.mappingsDirty = true
    const parent = localTask(projA.project, { title: 'Parent' })
    const child = localTask(projA.project, { title: 'Child', assignees: ['Alice'] }, parent.id)
    const dep = localTask(projA.project, { title: 'Dep' })
    child.dependencies = [dep.id]
    await exportTasks(a.plugin, projA.project, [parent.id, child.id, dep.id])
    stopMockServer()

    const b = harness({ adapter: shared, team: ['Alice'] })
    const projB = connect(b.plugin, { team: ['Alice'] })
    const stories = await fetchEpicStories(b.plugin, projB.project)
    await importStories(b.plugin, projB.project, stories)

    const bParent = projB.project.tasks.find((t) => t.title === 'Parent')
    const bChild = bParent?.subtasks.find((t) => t.title === 'Child')
    const bDep = projB.project.tasks.find((t) => t.title === 'Dep')
    expect(bChild).toBeTruthy()
    expect(bChild?.assignees).toEqual(['Alice'])
    expect(bChild?.dependencies).toEqual([bDep?.id])
  })

  it('a teammate working solely in JIRA: a full multi-change cycle reconciles into Obsidian', async () => {
    // One linked task exists in both; the JIRA-only teammate then renames it,
    // transitions it, reassigns it, and links it — all over HTTP via a 2nd client.
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]
    const a = localTask(project, { title: 'A', status: 'todo' })
    const b = localTask(project, { title: 'B' })
    await exportTasks(plugin, project, [a.id, b.id])
    const aKey = taskExt(a).key ?? ''
    const bKey = taskExt(b).key ?? ''

    const jira = must(makeClient(plugin, project)) // the JIRA-only teammate
    expect(await jira.editIssue(aKey, { summary: 'A (edited in Jira)' })).toBe(true)
    expect(await jira.transitionTo(aKey, 'Done')).toBe(true)
    expect(await jira.editIssue(aKey, { assignee: { accountId: 'mock:carol', displayName: 'Carol' } })).toBe(true)
    expect(await jira.createLink(aKey, bKey)).toBe(true) // A blocked by B

    rewind(cfg)
    await runSync(plugin, project)

    const after = must(findTask(project.tasks, a.id))
    expect(after.title).toBe('A (edited in Jira)')
    expect(after.status).toBe('done')
    expect(after.assignees).toEqual(['Carol']) // auto-created from the teammate's assignment
    expect(project.teamMembers).toContain('Carol')
    expect(after.dependencies).toEqual([b.id])
  })

  it('reflects a hand-edited mock JSON on the next sync', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const t = localTask(project, { title: 'Edit me', status: 'todo' })
    await exportTasks(plugin, project, [t.id])
    await runSync(plugin, project)

    // Simulate the user hand-editing jira-mock.json (title + status).
    await mutateMock(plugin, (s) => {
      const i = s.getIssue(taskExt(t).key ?? '')
      if (i) {
        i.fields.summary = 'Edited by hand'
        i.fields.status = statusObj('In Progress', 'In Progress')
        i.fields.updated = FUTURE
      }
    })
    await runSync(plugin, project)
    const after = findTask(project.tasks, t.id)
    expect(after?.title).toBe('Edited by hand')
    expect(after?.status).toBe('in-progress')
  })
})

describe('jira sync — a JIRA-only teammate (2nd client over real HTTP) [J→O]', () => {
  // A linked task in both worlds + a live 2nd JiraClient acting as the teammate.
  async function withTeammate(): Promise<{
    plugin: ReturnType<typeof harness>['plugin']
    project: ReturnType<typeof connect>['project']
    cfg: ReturnType<typeof connect>['cfg']
    jira: JiraClient
    a: ReturnType<typeof localTask>
    b: ReturnType<typeof localTask>
  }> {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]
    const a = localTask(project, { title: 'A', status: 'todo' })
    const b = localTask(project, { title: 'B' })
    await exportTasks(plugin, project, [a.id, b.id])
    const jira = must(makeClient(plugin, project))
    return { plugin, project, cfg, jira, a, b }
  }

  it('teammate transitions an issue → Obsidian adopts (JIRA wins)', async () => {
    const { plugin, project, cfg, jira, a } = await withTeammate()
    expect(await jira.transitionTo(taskExt(a).key ?? '', 'In Progress')).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).status).toBe('in-progress')
  })

  it('teammate edits summary + priority → Obsidian adopts', async () => {
    const { plugin, project, cfg, jira, a } = await withTeammate()
    expect(await jira.editIssue(taskExt(a).key ?? '', { summary: 'Renamed in Jira', priority: { name: 'Low' } })).toBe(
      true
    )
    rewind(cfg)
    await runSync(plugin, project)
    const t = must(findTask(project.tasks, a.id))
    expect(t.title).toBe('Renamed in Jira')
    expect(t.priority).toBe('low')
  })

  it('teammate reassigns to a new user → Obsidian auto-creates the member', async () => {
    const { plugin, project, cfg, jira, a } = await withTeammate()
    expect(
      await jira.editIssue(taskExt(a).key ?? '', { assignee: { accountId: 'mock:carol', displayName: 'Carol' } })
    ).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).assignees).toEqual(['Carol'])
    expect(project.teamMembers).toContain('Carol')
  })

  it('teammate creates and later removes a blocks link → Obsidian deps follow', async () => {
    const { plugin, project, cfg, jira, a, b } = await withTeammate()
    const aKey = taskExt(a).key ?? ''
    const bKey = taskExt(b).key ?? ''
    expect(await jira.createLink(aKey, bKey)).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).dependencies).toEqual([b.id])

    const linkId = must((await jira.getIssue(aKey))?.blockLinks[0]?.id, 'link id')
    expect(await jira.deleteLink(linkId)).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).dependencies).toEqual([])
  })

  it('teammate unassigns an issue → Obsidian clears the assignee', async () => {
    const { plugin, project, cfg, jira, a } = await withTeammate()
    const key = taskExt(a).key ?? ''
    expect(await jira.editIssue(key, { assignee: { accountId: 'mock:alice', displayName: 'Alice' } })).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).assignees).toEqual(['Alice'])

    expect(await jira.editIssue(key, { assignee: null })).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).assignees).toEqual([])
  })

  it('teammate edits due + start dates → Obsidian adopts both', async () => {
    const { plugin, project, cfg, jira, a } = await withTeammate()
    const startField = (await readMock(plugin)).startFieldId
    expect(await jira.editIssue(taskExt(a).key ?? '', { duedate: '2026-10-10', [startField]: '2026-10-01' })).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    const t = must(findTask(project.tasks, a.id))
    expect(t.due).toBe('2026-10-10')
    expect(t.start).toBe('2026-10-01')
  })

  it('teammate flags an issue as a milestone via entity property → Obsidian sets type', async () => {
    const { plugin, project, cfg, jira, a } = await withTeammate()
    expect(await jira.setProperty(taskExt(a).key ?? '', ISSUE_PROP, { milestone: true } satisfies JiraIssueProps)).toBe(
      true
    )
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).type).toBe('milestone')
  })

  it('teammate creates a brand-new story+subtask → surfaced as new, then imported nested', async () => {
    const { plugin, project, cfg, jira } = await withTeammate()
    const story = await jira.createIssue({
      project: { key: 'DEMO' },
      issuetype: { name: 'Story' },
      summary: 'Born in Jira',
      parent: { key: EPIC }
    })
    const sKey = must('key' in story ? story.key : undefined, 'story key')
    await jira.createIssue({
      project: { key: 'DEMO' },
      issuetype: { name: 'Sub-task' },
      summary: 'Jira subtask',
      parent: { key: sKey }
    })

    rewind(cfg)
    const r = await runSync(plugin, project)
    expect(r.newIssues.map((i) => i.summary)).toContain('Born in Jira')

    const stories = await fetchEpicStories(plugin, project)
    await importStories(plugin, project, stories)
    const story1 = project.tasks.find((t) => t.title === 'Born in Jira')
    expect(story1?.subtasks.map((s) => s.title)).toEqual(['Jira subtask'])
  })

  it('a rejected status push is not silently marked synced (stays dirty + limbo)', async () => {
    // Map our "done" to a JIRA status the workflow has no transition to → the push
    // is rejected. We must not advance the shadow or drop the change.
    const { plugin, project, cfg, jira, a } = await withTeammate()
    void jira
    cfg.statusMap = cfg.statusMap.map((e) => (e.target === 'done' ? { ...e, jira: 'Ghost' } : e))
    a.status = 'done'
    cfg.dirtyQueue = [a.id]
    rewind(cfg)
    await runSync(plugin, project)

    const issue = mustIssue(await readMock(plugin), taskExt(a).key ?? '')
    expect((issue.fields.status as { name: string }).name).toBe('To Do') // JIRA untouched
    const t = must(findTask(project.tasks, a.id))
    expect(taskExt(t).reconciled).toBe(false) // surfaced as a conflict, not a success
    // The shadow was NOT advanced to "done", so next sync still sees a local
    // divergence and retries the push — the change isn't silently dropped.
    expect(taskExt(t).shadow?.status).not.toBe('done')
  })

  it('a status-only local edit does NOT wipe a teammate-set due date (no data loss)', async () => {
    const { plugin, project, cfg, jira, a } = await withTeammate()
    const aKey = taskExt(a).key ?? ''
    // Teammate sets a due date in JIRA that Obsidian has never seen.
    expect(await jira.editIssue(aKey, { duedate: '2026-12-12' })).toBe(true)
    // We change only the status locally.
    a.status = 'in-progress'
    cfg.dirtyQueue = [a.id]
    rewind(cfg)
    await runSync(plugin, project)

    // The teammate's due survived (we never sent an empty duedate)…
    expect(mustIssue(await readMock(plugin), aKey).fields.duedate).toBe('2026-12-12')
    // …our status landed, and the due was adopted locally.
    const t = must(findTask(project.tasks, a.id))
    expect(t.status).toBe('in-progress')
    expect(t.due).toBe('2026-12-12')
  })

  it('concurrent edits to DIFFERENT fields do not clobber (field-level shadow diff)', async () => {
    // The teammate edits the summary in JIRA; we change only the due date locally.
    // The dirty push must send ONLY the due (changed vs shadow), leaving the
    // teammate's summary intact — no data loss.
    const { plugin, project, cfg, jira, a } = await withTeammate()
    const aKey = taskExt(a).key ?? ''
    expect(await jira.editIssue(aKey, { summary: 'Jira title' })).toBe(true)
    a.due = '2026-09-09'
    cfg.dirtyQueue = [a.id]
    rewind(cfg)
    await runSync(plugin, project)

    const issue = mustIssue(await readMock(plugin), aKey)
    expect(issue.fields.duedate).toBe('2026-09-09') // our change pushed
    expect(issue.fields.summary).toBe('Jira title') // teammate's change preserved
    expect(must(findTask(project.tasks, a.id)).title).toBe('Jira title') // and adopted locally
  })

  it('a teammate field edit with NO competing local change is adopted cleanly', async () => {
    // The non-clobber case: when we are not dirty, JIRA's field edits win inbound.
    const { plugin, project, cfg, jira, a } = await withTeammate()
    expect(await jira.editIssue(taskExt(a).key ?? '', { summary: 'Clean from Jira' })).toBe(true)
    rewind(cfg)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, a.id)).title).toBe('Clean from Jira')
  })
})

describe('jira sync — per-field conflict resolution [both]', () => {
  /** Set up a synced task, then have both sides change `start` to DIFFERENT values. */
  async function withStartConflict() {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    const a = localTask(project, { title: 'A', status: 'todo', start: '2026-01-01' })
    await exportTasks(plugin, project, [a.id])
    await runSync(plugin, project) // establish the shadow baseline
    const jira = must(makeClient(plugin, project))
    const aKey = taskExt(a).key ?? ''
    const startField = (await readMock(plugin)).startFieldId
    // Teammate moves start in JIRA; we move it locally to a different date.
    expect(await jira.editIssue(aKey, { [startField]: '2026-03-03' })).toBe(true)
    a.start = '2026-02-02'
    cfg.dirtyQueue = [a.id]
    rewind(cfg)
    const r = await runSync(plugin, project)
    return { plugin, project, cfg, jira, a, aKey, startField, r }
  }

  it('flags a both-sided field clash and captures the JIRA snapshot', async () => {
    const { project, a, r } = await withStartConflict()
    expect(r.conflicts).toBe(1)
    const t = must(findTask(project.tasks, a.id))
    expect(taskExt(t).reconciled).toBe(false)
    expect(taskExt(t).conflict?.theirs.start).toBe('2026-03-03') // JIRA side captured
    expect(t.start).toBe('2026-02-02') // local kept until resolved
  })

  it('resolve "take Jira" adopts JIRA\'s value, advances the shadow, clears the flag', async () => {
    const { plugin, project, a } = await withStartConflict()
    const t = must(findTask(project.tasks, a.id))
    await resolveConflict(plugin, project, t, ['start'])
    const after = must(findTask(project.tasks, a.id))
    expect(after.start).toBe('2026-03-03') // took JIRA's value
    expect(taskExt(after).reconciled).toBeUndefined() // cleared
    expect(taskExt(after).conflict).toBeUndefined()
    expect(taskExt(after).shadow?.start).toBe('2026-03-03') // baseline advanced
  })

  it('resolve "keep mine" holds local, then the next sync pushes it to JIRA', async () => {
    const { plugin, project, cfg, a, aKey } = await withStartConflict()
    const t = must(findTask(project.tasks, a.id))
    await resolveConflict(plugin, project, t, []) // keep all Obsidian
    const after = must(findTask(project.tasks, a.id))
    expect(after.start).toBe('2026-02-02') // local retained
    expect(taskExt(after).conflict).toBeUndefined()

    rewind(cfg)
    await runSync(plugin, project)
    const startField = (await readMock(plugin)).startFieldId
    expect(mustIssue(await readMock(plugin), aKey).fields[startField]).toBe('2026-02-02') // pushed
  })
})

describe('jira sync — descriptions [J→O]', () => {
  it('imports the issue description into the task, converted from ADF', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    await mutateMock(plugin, (s) => {
      s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Story' },
        summary: 'Documented',
        parent: { key: EPIC },
        description: {
          type: 'doc',
          version: 1,
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Why' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Because.' }] }
          ]
        }
      })
    })

    await importStories(plugin, project, await fetchEpicStories(plugin, project))

    const task = project.tasks.find((t) => t.title === 'Documented')
    expect(task?.description).toBe('## Why\n\nBecause.')
  })

  it('leaves the description empty when the issue has none', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    await mutateMock(plugin, (s) => {
      s.createIssue({ project: { key: 'DEMO' }, issuetype: { name: 'Story' }, summary: 'Bare', parent: { key: EPIC } })
    })

    await importStories(plugin, project, await fetchEpicStories(plugin, project))

    expect(project.tasks.find((t) => t.title === 'Bare')?.description).toBe('')
  })
})

/*
 * Descriptions are a synced field like any other, with one wrinkle: they round-trip
 * through Jira's ADF format, so equality has to be canonical or every sync after a push
 * would read the conversion as a remote edit and rewrite the note.
 */
describe('jira sync — descriptions [both]', () => {
  async function linked(description: string) {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const task = localTask(project, { title: 'Linked', description })
    await exportTasks(plugin, project, [task.id])
    await runSync(plugin, project)
    return { plugin, project, task, key: must(taskExt(task).key) }
  }
  const jiraDescription = async (plugin: ReturnType<typeof harness>['plugin'], key: string) =>
    (await readMock(plugin)).getIssue(key)?.fields.description

  it('pushes the description when the task is created', async () => {
    const { plugin, key } = await linked('# Why\n\nBecause **it matters**.')
    expect(adfToMarkdown(await jiraDescription(plugin, key))).toBe('# Why\n\nBecause **it matters**.')
  })

  it('pushes a later local edit', async () => {
    const { plugin, project, task, key } = await linked('First.')
    must(findTask(project.tasks, task.id)).description = 'Second.'

    await runSync(plugin, project)

    expect(adfToMarkdown(await jiraDescription(plugin, key))).toBe('Second.')
  })

  it('adopts an edit made in Jira', async () => {
    const { plugin, project, task, key } = await linked('Mine.')
    await mutateMock(plugin, (s) => {
      const issue = mustIssue(s, key)
      issue.fields.description = markdownToAdf('Theirs.')
      issue.fields.updated = FUTURE
    })

    await runSync(plugin, project)

    expect(must(findTask(project.tasks, task.id)).description).toBe('Theirs.')
  })

  it('leaves an untouched description alone — the round trip is not an edit', async () => {
    const { plugin, project, task } = await linked('- one\n- two\n\nSome **bold**.')
    const before = must(findTask(project.tasks, task.id)).description

    await runSync(plugin, project)
    await runSync(plugin, project)

    expect(must(findTask(project.tasks, task.id)).description).toBe(before)
    expect(taskExt(must(findTask(project.tasks, task.id))).reconciled).not.toBe(false)
  })

  it('is not fooled when the round trip reformats — "* a" comes home as "- a"', async () => {
    // Jira has no notion of which bullet character you typed, so this text cannot survive
    // literally. Without a canonical comparison the next sync reads it as someone else's
    // edit and rewrites the note — on every sync, forever.
    const { plugin, project, task } = await linked('* one\n* two')
    expect(canonicalDescription('* one\n* two')).not.toBe('* one\n* two') // the premise

    await runSync(plugin, project)
    await runSync(plugin, project)

    const after = must(findTask(project.tasks, task.id))
    expect(after.description).toBe('* one\n* two') // left exactly as written
    expect(taskExt(after).reconciled).not.toBe(false)
  })

  it('flags a conflict when both sides changed it', async () => {
    const { plugin, project, task, key } = await linked('Original.')
    must(findTask(project.tasks, task.id)).description = 'My version.'
    await mutateMock(plugin, (s) => {
      const issue = mustIssue(s, key)
      issue.fields.description = markdownToAdf('Their version.')
      issue.fields.updated = FUTURE
    })

    await runSync(plugin, project)

    const after = must(findTask(project.tasks, task.id))
    expect(taskExt(after).reconciled).toBe(false)
    expect(after.description).toBe('My version.') // local kept until resolved
  })
})

/*
 * Two failures seen against a real instance, in one sequence: resolving a description
 * conflict in Jira's favour changed nothing locally but moved the shadow, so the next sync
 * pushed the untouched local text back over Jira's — and where the description held an
 * attachment, Jira ended up with the literal words "[jira attachment <id>]" in place of
 * the file.
 */
describe('jira sync — descriptions must not damage Jira [both]', () => {
  async function conflicted(mine: string, theirs: string) {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const task = localTask(project, { title: 'Doc', description: 'Original.' })
    await exportTasks(plugin, project, [task.id])
    await runSync(plugin, project)
    const key = must(taskExt(task).key)
    must(findTask(project.tasks, task.id)).description = mine
    await mutateMock(plugin, (s) => {
      const issue = mustIssue(s, key)
      issue.fields.description = markdownToAdf(theirs)
      issue.fields.updated = FUTURE
    })
    await runSync(plugin, project)
    return { plugin, project, task, key }
  }
  const jiraText = async (plugin: ReturnType<typeof harness>['plugin'], key: string) =>
    adfToMarkdown((await readMock(plugin)).getIssue(key)?.fields.description)

  it('writes Jira’s description into the note when the conflict is resolved that way', async () => {
    const { plugin, project, task } = await conflicted('Mine.', 'Theirs.')
    expect(taskExt(must(findTask(project.tasks, task.id))).reconciled).toBe(false)

    await resolveConflict(plugin, project, must(findTask(project.tasks, task.id)), ['description'])

    expect(must(findTask(project.tasks, task.id)).description).toBe('Theirs.')
  })

  it('does not push the local text back after adopting Jira’s', async () => {
    const { plugin, project, task, key } = await conflicted('Mine.', 'Theirs.')
    await resolveConflict(plugin, project, must(findTask(project.tasks, task.id)), ['description'])

    await runSync(plugin, project)

    expect(await jiraText(plugin, key)).toBe('Theirs.')
  })

  it('puts the attachment back when the note around it is edited', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const task = localTask(project, { title: 'Doc' })
    await exportTasks(plugin, project, [task.id])
    const key = must(taskExt(task).key)
    await mutateMock(plugin, (s) => {
      const issue = mustIssue(s, key)
      issue.fields.description = {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'See:' }] },
          {
            type: 'mediaSingle',
            attrs: { layout: 'center' },
            content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file', alt: 'Shot.png' } }]
          }
        ]
      }
      issue.fields.updated = FUTURE
    })
    await runSync(plugin, project) // adopt it

    const local = must(findTask(project.tasks, task.id))
    expect(local.description).toContain('jira-media:abc-123')
    local.description = `Extra context.\n\n${local.description}`
    await runSync(plugin, project)

    const stored = JSON.stringify((await readMock(plugin)).getIssue(key)?.fields.description)
    expect(stored).toContain('"mediaSingle"') // a real node, not the words describing one
    expect(stored).toContain('abc-123')
    expect(stored).toContain('Extra context.') // and the edit landed
  })

  it('refuses to clear a description Jira has', async () => {
    const { plugin, project, task, key } = await conflicted('', 'Theirs.')
    await resolveConflict(plugin, project, must(findTask(project.tasks, task.id)), [])

    await runSync(plugin, project)

    expect(await jiraText(plugin, key)).toBe('Theirs.')
  })
})
