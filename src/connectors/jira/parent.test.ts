import { afterEach, describe, expect, it } from 'vitest'
import { addTaskToTree, deleteTaskFromTree, findTask, flattenTasks } from '../../store/TaskTreeOps'
import { FUTURE, connect, harness, localTask, must, mutateMock, readMock, setDefaultMaps } from './test-harness'
import type { JiraMockStore } from './JiraMock'
import { stopMockServer } from './JiraMockServer'
import type { Project } from '../../types'
import { taskExt } from './types'
import { exportTasks, runSync } from './sync'

/*
 * The Jira parent must always mirror the Obsidian parent. Two ways that broke live:
 *   - creating a task whose parent isn't synced fell back to the epic, so it was made a
 *     level too high (an Epic instead of a child) instead of being held back
 *   - reparenting in Obsidian never reached Jira at all, because `parent` isn't one of
 *     the merged shadow fields and a pure reparent looks like "nothing changed"
 */
afterEach(() => stopMockServer())

const EPIC = 'DEMO-100'
const parentKeyOf = async (plugin: ReturnType<typeof harness>['plugin'], key: string): Promise<string | undefined> => {
  const mock = await readMock(plugin)
  return (mock.getIssue(key)?.fields.parent as { key?: string } | undefined)?.key
}
const issueTypeOf = async (plugin: ReturnType<typeof harness>['plugin'], key: string): Promise<string | undefined> => {
  const mock = await readMock(plugin)
  return (mock.getIssue(key)?.fields.issuetype as { name?: string } | undefined)?.name
}
/** The task's parent id in the local tree (null at top level) — what a J→O move must change. */
const localParentIdOf = (project: Project, taskId: string): string | null | undefined =>
  flattenTasks(project.tasks).find((f) => f.task.id === taskId)?.parentId
/** How many issues exist in the mock — a duplicate created behind our back shows up here. */
const issueCount = (mock: JiraMockStore): number => Object.keys(mock.data.issues).length
/** Reparent an issue in the mock and mark it changed, as a teammate's move in Jira would. */
const moveInJira = (plugin: ReturnType<typeof harness>['plugin'], key: string, parentKey: string): Promise<void> =>
  mutateMock(plugin, (s) => {
    const i = must(s.getIssue(key))
    i.fields.parent = { key: parentKey }
    i.fields.updated = FUTURE
  })

describe('jira parent hierarchy [O→J]', () => {
  it('refuses to create a task whose parent is not synced (never re-roots onto the epic)', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const parent = localTask(project, { title: 'Parent' })
    const child = localTask(project, { title: 'Child' }, parent.id)
    // Export ONLY the child — its parent stays unsynced.
    const { created, skipped } = await exportTasks(plugin, project, [child.id])

    expect(created).toBe(0)
    expect(skipped).toEqual(['Child'])
    expect(taskExt(must(findTask(project.tasks, child.id))).key).toBeUndefined()
  })

  it('creates parent-first when both are exported together', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const parent = localTask(project, { title: 'Parent' })
    const child = localTask(project, { title: 'Child' }, parent.id)
    const { created, skipped } = await exportTasks(plugin, project, [parent.id, child.id])

    expect(created).toBe(2)
    expect(skipped).toEqual([])
    expect(await parentKeyOf(plugin, must(taskExt(parent).key))).toBe(EPIC)
    expect(await parentKeyOf(plugin, must(taskExt(child).key))).toBe(taskExt(parent).key)
  })

  it('pushes a reparent to Jira even when nothing else changed', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const a = localTask(project, { title: 'Parent A' })
    const b = localTask(project, { title: 'Parent B' })
    const child = localTask(project, { title: 'Child' }, a.id)
    await exportTasks(plugin, project, [a.id, b.id, child.id])
    const childKey = must(taskExt(child).key)
    expect(await parentKeyOf(plugin, childKey)).toBe(taskExt(a).key)

    // Move the child under B in Obsidian — the ONLY change. (Same tree ops the real
    // ProjectStore.moveTasks performs; the harness store only stubs what sync calls.)
    const moved = must(findTask(project.tasks, child.id))
    deleteTaskFromTree(project.tasks, child.id)
    addTaskToTree(project.tasks, moved, b.id)
    await runSync(plugin, project)

    expect(await parentKeyOf(plugin, childKey)).toBe(taskExt(b).key)
  })

  it('changes the Jira issue type when a reparent moves the task down a level', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    // Both start at the top level, so both are created as the root's child type.
    const keeper = localTask(project, { title: 'Keeper' })
    const stray = localTask(project, { title: 'Stray' })
    await exportTasks(plugin, project, [keeper.id, stray.id])
    const strayKey = must(taskExt(stray).key)
    expect(await issueTypeOf(plugin, strayKey)).toBe('Task')

    // The mistake being corrected: it belonged under the other task all along.
    const moved = must(findTask(project.tasks, stray.id))
    deleteTaskFromTree(project.tasks, stray.id)
    addTaskToTree(project.tasks, moved, keeper.id)
    await runSync(plugin, project)

    expect(await parentKeyOf(plugin, strayKey)).toBe(taskExt(keeper).key)
    // Without the type change Jira would refuse the parent: a Task can't parent a Task.
    expect(await issueTypeOf(plugin, strayKey)).toBe('Sub-task')
  })

  it('leaves the issue type alone when the new parent is at the same level', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const a = localTask(project, { title: 'Parent A' })
    const b = localTask(project, { title: 'Parent B' })
    const child = localTask(project, { title: 'Child' }, a.id)
    await exportTasks(plugin, project, [a.id, b.id, child.id])
    const childKey = must(taskExt(child).key)
    expect(await issueTypeOf(plugin, childKey)).toBe('Sub-task')

    const moved = must(findTask(project.tasks, child.id))
    deleteTaskFromTree(project.tasks, child.id)
    addTaskToTree(project.tasks, moved, b.id)
    await runSync(plugin, project)

    expect(await parentKeyOf(plugin, childKey)).toBe(taskExt(b).key)
    expect(await issueTypeOf(plugin, childKey)).toBe('Sub-task')
  })

  it('holds a task whose parent became unsynced instead of silently re-rooting it', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const parent = localTask(project, { title: 'Parent' })
    const child = localTask(project, { title: 'Child' }, parent.id)
    await exportTasks(plugin, project, [parent.id, child.id])
    const childKey = must(taskExt(child).key)

    // Unlink the parent locally (as "uncheck sync" does), leaving the child orphaned.
    await mutateMock(plugin, () => undefined) // no-op; keeps the mock server warm
    const p = must(findTask(project.tasks, parent.id))
    if (p.ext) Reflect.deleteProperty(p.ext, 'jira')

    const r = await runSync(plugin, project)
    expect(r.conflicts).toBeGreaterThan(0)
    // Jira still points at the original parent — nothing was re-rooted onto the epic.
    expect(await parentKeyOf(plugin, childKey)).not.toBe(EPIC)
  })
})

describe('jira issue types are preserved [O→J]', () => {
  it('does not turn a Bug into a Task when it moves to another parent at the same level', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seeds the root issue in the mock
    // Make the root an Initiative, so top-level tasks are Epics and *their* children sit
    // at the standard level where a Bug can live.
    await mutateMock(plugin, (s) => {
      must(s.getIssue(EPIC)).fields.issuetype = { name: 'Initiative', subtask: false }
    })

    const a = localTask(project, { title: 'Epic A' })
    const b = localTask(project, { title: 'Epic B' })
    const bug = localTask(project, { title: 'Crash on boot' }, a.id)
    await exportTasks(plugin, project, [a.id, b.id, bug.id])
    const bugKey = must(taskExt(bug).key)
    expect(await issueTypeOf(plugin, bugKey)).toBe('Task') // created as the level's default
    // Someone retypes it in Jira, as they do.
    await mutateMock(plugin, (s) => {
      must(s.getIssue(bugKey)).fields.issuetype = { name: 'Bug', subtask: false }
    })

    // Move it under B: same level, so only the parent should change.
    const moved = must(findTask(project.tasks, bug.id))
    deleteTaskFromTree(project.tasks, bug.id)
    addTaskToTree(project.tasks, moved, b.id)
    await runSync(plugin, project)

    expect(await parentKeyOf(plugin, bugKey)).toBe(taskExt(b).key)
    expect(await issueTypeOf(plugin, bugKey)).toBe('Bug') // not rewritten to the level's default
  })
})

describe('jira parent hierarchy [J→O]', () => {
  /** a, b at the top level; child under a. All three synced. Returns the child's key. */
  const tree = async (
    plugin: ReturnType<typeof harness>['plugin'],
    project: Project
  ): Promise<{ a: string; b: string; childId: string; childKey: string }> => {
    const a = localTask(project, { title: 'Parent A' })
    const b = localTask(project, { title: 'Parent B' })
    const child = localTask(project, { title: 'Child' }, a.id)
    await exportTasks(plugin, project, [a.id, b.id, child.id])
    return {
      a: must(taskExt(a).key),
      b: must(taskExt(b).key),
      childId: child.id,
      childKey: must(taskExt(child).key)
    }
  }

  it('adopts a reparent made in Jira instead of reverting it', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { b, childId, childKey } = await tree(plugin, project)

    await moveInJira(plugin, childKey, b) // a teammate moves it under B
    const r = await runSync(plugin, project)

    expect(r.conflicts).toBe(0)
    // Local tree followed the move…
    const bId = must(
      findTask(project.tasks, must(flattenTasks(project.tasks).find((f) => taskExt(f.task).key === b)).task.id)
    ).id
    expect(localParentIdOf(project, childId)).toBe(bId)
    // …and Jira wasn't rewritten back to A on the way out.
    expect(await parentKeyOf(plugin, childKey)).toBe(b)
  })

  it('adopts a move up to the root as a top-level task', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { childId, childKey } = await tree(plugin, project)

    await moveInJira(plugin, childKey, EPIC)
    await runSync(plugin, project)

    expect(localParentIdOf(project, childId)).toBeNull()
    expect(await parentKeyOf(plugin, childKey)).toBe(EPIC)
  })

  it('conflicts when both sides moved the task to different parents', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { a, b, childId, childKey } = await tree(plugin, project)
    void a

    // Jira moves it under B; Obsidian moves it under a third task.
    const c = localTask(project, { title: 'Parent C' })
    await exportTasks(plugin, project, [c.id])
    const moved = must(findTask(project.tasks, childId))
    deleteTaskFromTree(project.tasks, childId)
    addTaskToTree(project.tasks, moved, c.id)
    await moveInJira(plugin, childKey, b)

    const r = await runSync(plugin, project)

    expect(r.conflicts).toBe(1)
    expect(taskExt(must(findTask(project.tasks, childId))).reconciled).toBe(false)
    // Neither side applied: local keeps C, Jira keeps B — the user picks in the resolver.
    expect(localParentIdOf(project, childId)).toBe(c.id)
    expect(await parentKeyOf(plugin, childKey)).toBe(b)
  })

  it('holds the move when the new Jira parent is not a task in the project', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { a, childId, childKey } = await tree(plugin, project)

    // A sibling issue exists in Jira under the epic but was never imported here.
    let stranger = ''
    await mutateMock(plugin, (s) => {
      stranger = must(s.createIssue({ issuetype: { name: 'Task' }, summary: 'Not here', parent: { key: EPIC } })).key
    })
    await moveInJira(plugin, childKey, stranger)

    const r = await runSync(plugin, project)

    expect(r.conflicts).toBe(1)
    // Nothing moved locally, and the shadow didn't advance — the next sync sees it again.
    const t = must(findTask(project.tasks, childId))
    expect(localParentIdOf(project, childId)).toBe(
      must(flattenTasks(project.tasks).find((f) => taskExt(f.task).key === a)).task.id
    )
    expect(must(taskExt(t).shadow).parent).toBe(a)
  })
})

/*
 * A parent moved OUT of the mapped root's subtree can't be represented locally at all —
 * the task's issue simply isn't in the tree we sync. Archiving is what takes it out of the
 * active set: it keeps the Jira key (so the task is never mistaken for a new local one and
 * recreated as a duplicate) while stopping every read and write for it.
 */
describe('jira parent moved out of scope → archive [J→O]', () => {
  /** A synced child under a synced parent, plus a second root issue outside the epic. */
  const setup = async (
    plugin: ReturnType<typeof harness>['plugin'],
    project: Project
  ): Promise<{ parentId: string; childId: string; childKey: string; outside: string }> => {
    const parent = localTask(project, { title: 'Parent' })
    const child = localTask(project, { title: 'Child' }, parent.id)
    await exportTasks(plugin, project, [parent.id, child.id])
    let outside = ''
    await mutateMock(plugin, (s) => {
      outside = s.createIssue({ issuetype: { name: 'Epic' }, summary: 'Another root' }).key
    })
    return { parentId: parent.id, childId: child.id, childKey: must(taskExt(child).key), outside }
  }

  it('archives the task, keeping its Jira key', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { childId, childKey, outside } = await setup(plugin, project)

    await moveInJira(plugin, childKey, outside)
    const r = await runSync(plugin, project) // full sync: crawls the whole subtree

    expect(r.archived).toBe(1)
    const t = must(findTask(project.tasks, childId))
    expect(t.archived).toBe(true)
    expect(taskExt(t).outOfScope).toBe(true)
    expect(taskExt(t).key).toBe(childKey) // still linked — not a keyless task to recreate

    // And it stays that way: a further sync doesn't create a replacement issue.
    const before = issueCount(await readMock(plugin))
    await runSync(plugin, project)
    expect(issueCount(await readMock(plugin))).toBe(before)
  })

  it('stops pushing local edits once a task is archived', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { childId, childKey } = await setup(plugin, project)

    // Archived in Obsidian while the issue is still in place: nothing about it goes out.
    const t = must(findTask(project.tasks, childId))
    t.archived = true
    t.title = 'Renamed while archived'
    const before = issueCount(await readMock(plugin))
    const r = await runSync(plugin, project)

    expect(r.jiraUpdated).toBe(0)
    expect(issueCount(await readMock(plugin))).toBe(before) // and no duplicate created
    expect((await readMock(plugin)).getIssue(childKey)?.fields.summary).toBe('Child')
  })

  it('archives on a periodic tick too, as soon as Jira reports the move', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { childId, childKey, outside } = await setup(plugin, project)

    // An incremental tick fetches tracked issues by key, so the new parent is right there
    // to check — no need to wait for a full crawl to notice.
    await moveInJira(plugin, childKey, outside)
    const r = await runSync(plugin, project, { full: false })

    expect(r.archived).toBe(1)
    expect(must(findTask(project.tasks, childId)).archived).toBe(true)
  })

  it('never archives a task a periodic tick simply did not fetch', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { childId, parentId } = await setup(plugin, project)
    await runSync(plugin, project) // settles the watermark past the issues just created

    // Nothing changed in Jira, so the incremental query returns nothing at all. Absence
    // here means "unchanged", not "gone" — reading it as gone archives the whole project.
    const r = await runSync(plugin, project, { full: false })

    expect(r.archived).toBe(0)
    expect(must(findTask(project.tasks, childId)).archived).toBeFalsy()
    expect(must(findTask(project.tasks, parentId)).archived).toBeFalsy()
  })

  it('brings the task back when the issue returns under the root', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { parentId, childId, childKey, outside } = await setup(plugin, project)
    await moveInJira(plugin, childKey, outside)
    await runSync(plugin, project)
    expect(must(findTask(project.tasks, childId)).archived).toBe(true)

    await moveInJira(plugin, childKey, must(taskExt(must(findTask(project.tasks, parentId))).key))
    await runSync(plugin, project)

    const t = must(findTask(project.tasks, childId))
    expect(t.archived).toBe(false)
    expect(taskExt(t).outOfScope).toBeUndefined()
  })

  it('does not un-archive a task archived by hand', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const { childId, childKey } = await setup(plugin, project)

    must(findTask(project.tasks, childId)).archived = true // archived in Obsidian, issue in place
    await mutateMock(plugin, (s) => {
      const i = must(s.getIssue(childKey))
      i.fields.summary = 'Changed in Jira'
      i.fields.updated = FUTURE
    })
    await runSync(plugin, project)

    const t = must(findTask(project.tasks, childId))
    expect(t.archived).toBe(true) // stays out of the active set
    expect(t.title).toBe('Child') // and the Jira-side edit isn't pulled in
  })

  it('never creates an issue for an archived task', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const t = localTask(project, { title: 'Archived idea' })
    t.archived = true
    t.ext = { ...t.ext, jira: { sync: true } } // opted in, then archived
    const before = issueCount(await readMock(plugin))
    const r = await runSync(plugin, project)

    expect(r.jiraCreated).toBe(0)
    expect(issueCount(await readMock(plugin))).toBe(before)
    expect(taskExt(must(findTask(project.tasks, t.id))).key).toBeUndefined()
  })
})
