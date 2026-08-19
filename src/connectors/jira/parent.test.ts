import { afterEach, describe, expect, it } from 'vitest'
import { addTaskToTree, deleteTaskFromTree, findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, mutateMock, readMock, setDefaultMaps } from './test-harness'
import { stopMockServer } from './JiraMockServer'
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
