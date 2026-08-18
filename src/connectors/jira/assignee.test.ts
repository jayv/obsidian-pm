import { afterEach, describe, expect, it } from 'vitest'
import { findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, mutateMock, readMock, rewind, setDefaultMaps } from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { taskExt } from './types'
import {
  exportTasks,
  fetchEpicStories,
  importStories,
  resolveConflict,
  runSync,
  searchJiraUsers,
  shadowOf
} from './sync'
import { conflictFields } from './reconcile'
import { renameAssigneeMapping } from './taskLink'

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
    cfgA.dirtyQueue = [ax.id]
    cfgB.dirtyQueue = [bx.id]
    rewind(cfgA)
    await runSync(plugin, projA) // A pushes Bob to JIRA
    expect((await readMock(plugin)).getIssue(key)?.fields.assignee).toMatchObject({ accountId: 'mock:bob' })
    rewind(cfgB)
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
    cfg.dirtyQueue = [t.id]
    rewind(cfg)
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
    rewind(cfg)
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
    rewind(cfg)
    await runSync(plugin, project) // pending conflict (unmapped)

    // Map Zoe → a real Jira user, then sync: the assignee now pushes and the task settles.
    await mutateMock(plugin, (s) => s.registerUser('mock:zoe', 'Zoe'))
    cfg.assigneeMap = [{ name: 'Zoe', jiraUser: 'mock:zoe' }]
    rewind(cfg)
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
    cfgA.dirtyQueue = [ax.id]
    cfgB.dirtyQueue = [bx.id]
    rewind(cfgB)
    await runSync(plugin, projB) // B pushes Carol + in-progress
    rewind(cfgA)
    const ra = await runSync(plugin, projA)
    expect(ra.conflicts).toBe(1)

    // Reproduce the merge editor's split: only fields WE changed that still differ are decisions.
    const t = must(findTask(projA.tasks, ax.id))
    const ext = taskExt(t)
    const fields = conflictFields(shadowOf(t), ext.shadow, must(ext.conflict).theirs)
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
