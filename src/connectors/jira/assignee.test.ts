import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTask } from '../../store/TaskTreeOps'
import {
  connect,
  harness,
  localTask,
  must,
  mutateMock,
  readMock,
  rewind,
  setDefaultMaps,
  sharedMap
} from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { sharedAssignees, taskExt } from './types'
import {
  exportTasks,
  fetchEpicStories,
  importStories,
  localParentKey,
  renameAcrossProjects,
  resolveConflict,
  runSync,
  searchJiraUsers,
  shadowOf
} from './sync'
import { conflictFields } from './reconcile'
import { addMemberFromJira, renameAssigneeMapping } from './taskLink'

afterEach(() => stopMockServer())

const TEAM = ['Alice', 'Bob', 'Carol']
const MAP = [
  { name: 'Alice', jiraUser: 'mock:alice' },
  { name: 'Bob', jiraUser: 'mock:bob' },
  { name: 'Carol', jiraUser: 'mock:carol' }
]

describe('jira sync — assignee conflicts [both]', () => {
  it('two projects edit the assignee from a shared baseline → conflict (A→Bob, B→Carol)', async () => {
    const { plugin } = harness({ team: TEAM })
    const { project: projA, cfg: cfgA } = connect(plugin, { title: 'A', team: TEAM })
    setDefaultMaps(cfgA)
    cfgA.assigneeMap = [...MAP]
    const ax = localTask(projA, { title: 'Shared', assignees: ['Alice'] })
    await exportTasks(plugin, projA, [ax.id])
    await runSync(plugin, projA)
    const key = taskExt(ax).key ?? ''

    const { project: projB, cfg: cfgB } = connect(plugin, { title: 'B', team: TEAM })
    setDefaultMaps(cfgB)
    cfgB.assigneeMap = [...MAP]
    await importStories(plugin, projB, await fetchEpicStories(plugin, projB))
    const bx = must(findTask(projB.tasks, projB.tasks[0].id))

    ax.assignees = ['Bob']
    bx.assignees = ['Carol']
    rewind(projA)
    await runSync(plugin, projA) // A pushes Bob to JIRA
    expect((await readMock(plugin)).getIssue(key)?.fields.assignee).toMatchObject({ accountId: 'mock:bob' })
    rewind(projB)
    const rb = await runSync(plugin, projB)

    expect(rb.conflicts).toBe(1)
    const after = must(findTask(projB.tasks, bx.id))
    expect(taskExt(after).reconciled).toBe(false)
    expect(taskExt(after).conflict?.theirs.assignees).toEqual(['Bob']) // JIRA side captured
  })

  it('assigning an UNMAPPED member surfaces as a conflict instead of silently vanishing', async () => {
    const { plugin } = harness({ team: TEAM })
    const { project, cfg } = connect(plugin, { team: TEAM })
    setDefaultMaps(cfg)
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }] // only Alice is mapped
    const t = localTask(project, { title: 'T', assignees: ['Alice'] })
    await exportTasks(plugin, project, [t.id])
    await runSync(plugin, project) // baseline: assignee Alice
    const key = taskExt(t).key ?? ''

    // Reassign locally to a member with no JIRA-user mapping.
    t.assignees = ['Bob']
    rewind(project)
    const r = await runSync(plugin, project)

    expect(r.conflicts).toBe(1) // not silently swallowed
    const after = must(findTask(project.tasks, t.id))
    expect(taskExt(after).reconciled).toBe(false)
    // JIRA keeps Alice (the unmapped change never pushed) and the shadow was NOT advanced
    // to Bob, so the next sync retries rather than treating it as synced.
    expect((await readMock(plugin)).getIssue(key)?.fields.assignee).toMatchObject({ accountId: 'mock:alice' })
    expect(taskExt(after).shadow?.assignees).toEqual(['Alice'])
  })

  it('does NOT drop a new task’s unmapped assignee on a later sync (create-path regression)', async () => {
    // The reported bug: create a task assigned to a member with no Jira mapping, sync
    // (which creates the issue but can't push the assignee), then a later background sync
    // dropped the assignee — because the created shadow wrongly recorded it as synced, so
    // the next reconcile read Jira's empty assignee as a remote deletion and adopted it.
    const { plugin } = harness({ team: TEAM })
    const { project, cfg } = connect(plugin, { team: TEAM })
    setDefaultMaps(cfg)
    cfg.assigneeMap = [] // Zoe is a team member but has no Jira-user mapping
    project.teamMembers = ['Zoe']
    const t = localTask(project, { title: 'T', assignees: ['Zoe'] })
    await exportTasks(plugin, project, [t.id]) // creates the issue; Zoe not pushed (unmapped)
    const key = taskExt(t).key ?? ''
    expect(key).toBeTruthy()
    // The created shadow must not claim Zoe was synced.
    expect(taskExt(must(findTask(project.tasks, t.id))).shadow?.assignees).toEqual([])
    expect((await readMock(plugin)).getIssue(key)?.fields.assignee ?? null).toBeNull()

    // A later (background) sync must keep Zoe on the task, surfaced as a conflict — never dropped.
    rewind(project)
    const r = await runSync(plugin, project)
    const after = must(findTask(project.tasks, t.id))
    expect(after.assignees).toEqual(['Zoe']) // the bug: this used to become []
    expect(r.conflicts).toBe(1)
    expect(taskExt(after).reconciled).toBe(false)
  })

  it('pushes the assignee once the member is mapped, clearing the pending conflict', async () => {
    const { plugin } = harness({ team: TEAM })
    const { project, cfg } = connect(plugin, { team: TEAM })
    setDefaultMaps(cfg)
    cfg.assigneeMap = []
    project.teamMembers = ['Zoe']
    const t = localTask(project, { title: 'T', assignees: ['Zoe'] })
    await exportTasks(plugin, project, [t.id])
    const key = taskExt(t).key ?? ''
    rewind(project)
    await runSync(plugin, project) // pending conflict (unmapped)

    // Map Zoe → a real Jira user, then sync: the assignee now pushes and the task settles.
    await mutateMock(plugin, (s) => s.registerUser('mock:zoe', 'Zoe'))
    cfg.assigneeMap = [{ name: 'Zoe', jiraUser: 'mock:zoe' }]
    rewind(project)
    const r = await runSync(plugin, project)

    expect((await readMock(plugin)).getIssue(key)?.fields.assignee).toMatchObject({ accountId: 'mock:zoe' })
    const after = must(findTask(project.tasks, t.id))
    expect(after.assignees).toEqual(['Zoe'])
    expect(taskExt(after).reconciled).not.toBe(false) // conflict cleared
    expect(taskExt(after).shadow?.assignees).toEqual(['Zoe'])
    void r
  })

  it('an assignee conflict alongside a Jira-only change shows ONLY the assignee as a decision', async () => {
    // A changes the assignee; B changes the assignee AND the status. From A's side the
    // status is a Jira-only change (it should auto-merge), so the editor must surface
    // only the assignee — not the status — as a conflict to resolve.
    const { plugin } = harness({ team: TEAM })
    const { project: projA, cfg: cfgA } = connect(plugin, { title: 'A', team: TEAM })
    setDefaultMaps(cfgA)
    cfgA.assigneeMap = [...MAP]
    const ax = localTask(projA, { title: 'Shared', status: 'todo', assignees: ['Alice'] })
    await exportTasks(plugin, projA, [ax.id])
    await runSync(plugin, projA)

    const { project: projB, cfg: cfgB } = connect(plugin, { title: 'B', team: TEAM })
    setDefaultMaps(cfgB)
    cfgB.assigneeMap = [...MAP]
    await importStories(plugin, projB, await fetchEpicStories(plugin, projB))
    const bx = must(findTask(projB.tasks, projB.tasks[0].id))

    ax.assignees = ['Bob'] // A: assignee only
    bx.assignees = ['Carol'] // B: assignee + status
    bx.status = 'in-progress'
    rewind(projB)
    await runSync(plugin, projB) // B pushes Carol + in-progress
    rewind(projA)
    const ra = await runSync(plugin, projA)
    expect(ra.conflicts).toBe(1)

    // Reproduce the merge editor's split: only fields WE changed that still differ are decisions.
    const t = must(findTask(projA.tasks, ax.id))
    const ext = taskExt(t)
    const mine = shadowOf(t, undefined, localParentKey(projA, t.id))
    const fields = conflictFields(mine, ext.shadow, must(ext.conflict).theirs)
    const decisions = fields.filter((f) => !f.defaultTakeTheirs).map((f) => f.field)
    const autoTheirs = fields.filter((f) => f.defaultTakeTheirs).map((f) => f.field)
    expect(decisions).toEqual(['assignees']) // only the contested field
    expect(autoTheirs).toEqual(['status']) // Jira-only change auto-merges

    // Resolve keeping our assignee: status adopts in-progress, assignee stays Bob.
    await resolveConflict(plugin, projA, t, autoTheirs)
    const done = must(findTask(projA.tasks, ax.id))
    expect(done.status).toBe('in-progress') // adopted from Jira
    expect(done.assignees).toEqual(['Bob']) // our change kept (re-pushes next sync)
    expect(taskExt(done).reconciled).toBeUndefined()
  })

  it('a team member added after the first sync is findable in the Jira user picker (mock)', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    const { project, cfg } = connect(plugin, { team: ['Alice'] })
    setDefaultMaps(cfg)
    await runSync(plugin, project) // first seed: only Alice is a mock user

    // A member added later (e.g. via a task assignment) must still be discoverable.
    project.teamMembers.push('Frank')
    const results = await searchJiraUsers(plugin, project, 'Frank')
    expect(results.map((u) => u.displayName)).toContain('Frank')
  })
})

describe('jira assignee map — team member renames [local]', () => {
  const map = () => [
    { name: 'Alice', jiraUser: 'mock:alice' },
    { name: 'Bob', jiraUser: 'mock:bob' }
  ]

  it('follows the member so they stay mapped', () => {
    const m = map()
    renameAssigneeMapping(m, 'Alice', 'Alice Smith')
    expect(m).toEqual([
      { name: 'Alice Smith', jiraUser: 'mock:alice' },
      { name: 'Bob', jiraUser: 'mock:bob' }
    ])
  })

  it('keeps the surviving member’s own mapping when two members merge', () => {
    const m = map()
    renameAssigneeMapping(m, 'Alice', 'Bob')
    expect(m).toEqual([{ name: 'Bob', jiraUser: 'mock:bob' }])
  })

  it('drops the mapping when the member is cleared', () => {
    const m = map()
    renameAssigneeMapping(m, 'Alice', '')
    expect(m).toEqual([{ name: 'Bob', jiraUser: 'mock:bob' }])
  })

  it('ignores a rename of someone who was never mapped', () => {
    const m = map()
    renameAssigneeMapping(m, 'Carol', 'Carol Jones')
    expect(m).toEqual(map())
  })
})

describe('jira assignee map — add a member from Jira [local]', () => {
  const ada = { accountId: 'acc:ada', displayName: 'Ada Lovelace' }

  it('adds the member and their mapping in one step', () => {
    const team: string[] = []
    const m: { name: string; jiraUser: string; jiraDisplay?: string }[] = []

    expect(addMemberFromJira(team, m, ada)).toEqual({ name: 'Ada Lovelace', added: true })
    expect(team).toEqual(['Ada Lovelace'])
    expect(m).toEqual([{ name: 'Ada Lovelace', jiraUser: 'acc:ada', jiraDisplay: 'Ada Lovelace' }])
  })

  it('reuses an existing member instead of adding a duplicate name', () => {
    const team = ['ada lovelace']
    const m: { name: string; jiraUser: string; jiraDisplay?: string }[] = []

    expect(addMemberFromJira(team, m, ada)).toEqual({ name: 'ada lovelace', added: false })
    // One member, and the mapping is keyed to the name the tasks already use.
    expect(team).toEqual(['ada lovelace'])
    expect(m).toEqual([{ name: 'ada lovelace', jiraUser: 'acc:ada', jiraDisplay: 'Ada Lovelace' }])
  })

  it('ignores a Jira user with no display name', () => {
    const team: string[] = []
    expect(addMemberFromJira(team, [], { accountId: 'acc:x', displayName: '  ' })).toBeNull()
    expect(team).toEqual([])
  })
})

/*
 * Mappings are stored per Jira server in plugin settings, not per project: an accountId
 * only means anything on the site it came from, but within a site a person is the same
 * person on every project. Team member *names* stay on the project — assignment, avatars
 * and filters all read project.teamMembers, and that has nothing to do with Jira.
 */
describe('jira assignee map — centralized per server [local]', () => {
  it('folds a project-held map into the server list and stops the project carrying it', () => {
    const { plugin } = harness()
    const { cfg } = connect(plugin)
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]

    const shared = sharedAssignees(plugin, cfg)

    expect(shared).toEqual([{ name: 'Alice', jiraUser: 'mock:alice' }])
    expect(cfg.assigneeMap).toEqual([]) // moved, not copied
    expect(sharedMap(plugin)).toBe(shared) // and it is the server's own list
  })

  it('persists the moment it takes ownership, so a restart can’t lose the mapping', () => {
    const { plugin } = harness()
    const { cfg } = connect(plugin)
    const saved = vi.fn<() => Promise<void>>(() => Promise.resolve())
    plugin.saveSettings = saved
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]

    sharedAssignees(plugin, cfg)
    expect(saved).toHaveBeenCalledTimes(1)

    // Nothing left to fold — the hot path must not write settings on every read.
    sharedAssignees(plugin, cfg)
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('shares one list between two projects on the same server', () => {
    const { plugin } = harness()
    const a = connect(plugin, { title: 'A' })
    const b = connect(plugin, { title: 'B' })
    a.cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]

    sharedAssignees(plugin, a.cfg)

    expect(sharedAssignees(plugin, b.cfg).map((e) => e.name)).toEqual(['Alice'])
  })

  it('carries a rename to the other projects that knew the old name', async () => {
    const { plugin } = harness()
    const a = connect(plugin, { title: 'A', team: ['Ada'] })
    const b = connect(plugin, { title: 'B', team: ['Ada'] })
    const untouched = connect(plugin, { title: 'C', team: ['Grace'] })
    const otherSite = connect(plugin, { title: 'D', team: ['Ada'] })
    otherSite.cfg.serverId = 's2'
    const bTask = localTask(b.project, { title: 'Hers', assignees: ['Ada'] })

    // Renaming in A: the store does A itself, the connector carries it to the rest.
    plugin.store.renameAssignee(a.project, 'Ada', 'Ada Lovelace')
    await renameAcrossProjects(plugin, a.cfg.serverId, 'Ada', 'Ada Lovelace', a.project.filePath)

    expect(b.project.teamMembers).toEqual(['Ada Lovelace'])
    expect(must(findTask(b.project.tasks, bTask.id)).assignees).toEqual(['Ada Lovelace'])
    expect(untouched.project.teamMembers).toEqual(['Grace']) // never knew her — untouched
    expect(otherSite.project.teamMembers).toEqual(['Ada']) // different Jira site
  })

  it('keeps servers apart — an accountId only means something on its own site', () => {
    const { plugin } = harness()
    const a = connect(plugin, { title: 'A' })
    const b = connect(plugin, { title: 'B' })
    b.cfg.serverId = 's2'
    a.cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'mock:alice' }]

    sharedAssignees(plugin, a.cfg)

    expect(sharedAssignees(plugin, b.cfg)).toEqual([])
  })

  it('folding never clobbers a mapping already held centrally', () => {
    const { plugin } = harness()
    const { cfg } = connect(plugin)
    sharedMap(plugin).push({ name: 'Alice', jiraUser: 'central:alice' })
    cfg.assigneeMap = [{ name: 'Alice', jiraUser: 'stale:alice' }]

    expect(sharedAssignees(plugin, cfg)).toEqual([{ name: 'Alice', jiraUser: 'central:alice' }])
  })

  it('a mapping the sync discovers lands centrally, so a sibling project already has it', async () => {
    const { plugin } = harness({ team: ['Alice'] })
    const a = connect(plugin, { title: 'A', team: ['Alice'] })
    setDefaultMaps(a.cfg)
    await runSync(plugin, a.project)
    // Dana exists only in Jira; importing her should map her once, for the whole server.
    await mutateMock(plugin, (s) => {
      s.registerUser('mock:dana', 'Dana')
      s.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Story' },
        summary: 'Owned by Dana',
        parent: { key: 'DEMO-100' },
        assignee: { accountId: 'mock:dana', displayName: 'Dana' }
      })
    })
    await importStories(plugin, a.project, await fetchEpicStories(plugin, a.project))
    expect(sharedMap(plugin).some((e) => e.name === 'Dana')).toBe(true)

    // A second project on the same server sees her without any sync of its own.
    const b = connect(plugin, { title: 'B' })
    expect(sharedAssignees(plugin, b.cfg).some((e) => e.name === 'Dana')).toBe(true)
  })
})
