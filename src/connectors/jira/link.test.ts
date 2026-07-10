import { afterEach, describe, expect, it } from 'vitest'
import { findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, mutateMock, setDefaultMaps, statusObj } from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { ensureTaskExt, taskExt } from './types'
import { autoMatchByTitle, linkStoriesToTasks, runSync } from './sync'

// Matching an incoming Jira issue to an existing (keyless) Obsidian task instead of
// importing a duplicate: links the task, and surfaces field differences as conflicts.
afterEach(() => stopMockServer())

/** Create an incoming Jira issue under the epic; returns its key. */
async function incoming(
  plugin: ReturnType<typeof harness>['plugin'],
  fields: Record<string, unknown>
): Promise<string> {
  let key = ''
  await mutateMock(plugin, (s) => {
    const i = s.createIssue({ issuetype: { name: 'Task' }, parent: { key: 'DEMO-100' }, ...fields })
    if (fields.status) i.fields.status = fields.status
    key = i.key
  })
  return key
}

describe('jira match-to-existing (linkStoriesToTasks) [J→O]', () => {
  it('links the task and flags differing fields as a conflict (local kept, Jira captured)', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seed epic + meta
    const key = await incoming(plugin, { summary: 'Design doc', status: statusObj('In Progress', 'In Progress') })

    const t = localTask(project, { title: 'Design doc', status: 'todo' }) // same title, different status
    const r = await linkStoriesToTasks(plugin, project, [{ issueKey: key, taskId: t.id }])

    expect(r).toEqual({ linked: 1, conflicted: 1 })
    const after = must(findTask(project.tasks, t.id))
    expect(taskExt(after).key).toBe(key)
    expect(taskExt(after).sync).toBe(true)
    expect(taskExt(after).reconciled).toBe(false)
    expect(taskExt(after).conflict?.theirs.status).toBe('in-progress') // Jira snapshot captured
    expect(after.status).toBe('todo') // local kept until the user resolves
  })

  it('links cleanly (no conflict) when the task already matches the issue', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const key = await incoming(plugin, { summary: 'Same', status: statusObj('Done', 'Done') })

    const t = localTask(project, { title: 'Same', status: 'done', start: '', due: '' })
    const r = await linkStoriesToTasks(plugin, project, [{ issueKey: key, taskId: t.id }])

    expect(r).toEqual({ linked: 1, conflicted: 0 })
    const after = must(findTask(project.tasks, t.id))
    expect(taskExt(after).key).toBe(key)
    expect(taskExt(after).reconciled).not.toBe(false)
    expect(taskExt(after).shadow?.status).toBe('done')
  })

  it('autoMatchByTitle links same-title issues unambiguously (no dupes on re-import)', () => {
    const { plugin } = harness()
    const { project } = connect(plugin)
    const design = localTask(project, { title: 'Design doc' })
    const build = localTask(project, { title: '  BUILD it  ' }) // whitespace + case tolerant

    const m = autoMatchByTitle(
      [
        { key: 'MOCK-1', summary: 'Design doc' },
        { key: 'MOCK-2', summary: 'build it' },
        { key: 'MOCK-3', summary: 'Nothing local' }
      ],
      [design, build]
    )
    expect(m.get('MOCK-1')).toBe(design.id)
    expect(m.get('MOCK-2')).toBe(build.id)
    expect(m.has('MOCK-3')).toBe(false)
  })

  it('autoMatchByTitle leaves ambiguous titles and already-linked tasks for the user', () => {
    const { plugin } = harness()
    const { project } = connect(plugin)
    localTask(project, { title: 'Dup' }) // two local tasks share a title → ambiguous
    localTask(project, { title: 'Dup' })
    const linked = localTask(project, { title: 'Taken' })
    ensureTaskExt(linked).key = 'MOCK-9' // already linked → not a candidate

    const tasks = [...project.tasks]
    const m = autoMatchByTitle(
      [
        { key: 'MOCK-1', summary: 'Dup' },
        { key: 'MOCK-2', summary: 'Taken' }
      ],
      tasks
    )
    expect(m.has('MOCK-1')).toBe(false) // ambiguous
    expect(m.has('MOCK-2')).toBe(false) // already linked
  })

  it('autoMatchByTitle claims each task at most once', () => {
    const { plugin } = harness()
    const { project } = connect(plugin)
    const only = localTask(project, { title: 'Solo' })
    const m = autoMatchByTitle(
      [
        { key: 'MOCK-1', summary: 'Solo' },
        { key: 'MOCK-2', summary: 'Solo' } // same title, but the task is already used
      ],
      [only]
    )
    expect(m.get('MOCK-1')).toBe(only.id)
    expect(m.has('MOCK-2')).toBe(false)
  })

  it('skips a task that is already linked', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    const key = await incoming(plugin, { summary: 'X', status: statusObj('Done', 'Done') })
    const t = localTask(project, { title: 'X' })
    taskExt(t).key = 'DEMO-999' // pretend already linked elsewhere
    ;(t.ext ??= {}).jira = { key: 'DEMO-999' }

    const r = await linkStoriesToTasks(plugin, project, [{ issueKey: key, taskId: t.id }])
    expect(r.linked).toBe(0)
    expect(taskExt(must(findTask(project.tasks, t.id))).key).toBe('DEMO-999') // unchanged
  })
})
