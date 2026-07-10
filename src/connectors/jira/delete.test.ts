import { afterEach, describe, expect, it } from 'vitest'
import { deleteTaskFromTree, findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, setDefaultMaps } from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { ensureTaskExt, taskExt } from './types'
import { ignoreOnDelete } from './taskLink'
import { exportTasks, runSync } from './sync'

// A task deleted in Obsidian must not delete the Jira issue, and must not bounce back
// as a "new issue" on the next sync — the connector ignores its key instead.
// (JiraConnector.onTaskDeleted delegates to ignoreOnDelete; the store fires the hook
// over the deleted subtree — see ProjectStore.test.ts.)
afterEach(() => stopMockServer())

describe('jira delete handling [O→J]', () => {
  it('ignoreOnDelete adds a linked task’s key to ignoredKeys', () => {
    const { project, cfg } = connect(harness().plugin)
    const t = localTask(project, { title: 'T' })
    ensureTaskExt(t).key = 'DEMO-9'
    ignoreOnDelete(cfg, t)
    expect(cfg.ignoredKeys).toContain('DEMO-9')
  })

  it('ignoreOnDelete is a no-op for an unlinked task', () => {
    const { project, cfg } = connect(harness().plugin)
    ignoreOnDelete(cfg, localTask(project, { title: 'T' }))
    expect(cfg.ignoredKeys).toEqual([])
  })

  it('a deleted synced task is not re-offered as a new issue on the next sync', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const t = localTask(project, { title: 'T', status: 'todo' })
    await exportTasks(plugin, project, [t.id])
    const key = taskExt(must(findTask(project.tasks, t.id))).key ?? ''
    expect(key).toBeTruthy()

    // Simulate the Obsidian delete: the connector hook fires, then the task leaves the tree.
    ignoreOnDelete(cfg, must(findTask(project.tasks, t.id)))
    deleteTaskFromTree(project.tasks, t.id)

    const r = await runSync(plugin, project)
    expect(cfg.ignoredKeys).toContain(key) // issue left alone, not deleted
    expect(r.newIssues.map((i) => i.key)).not.toContain(key) // and not re-offered
  })

  it('without the ignore the orphaned issue bounces back (guards the regression)', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const t = localTask(project, { title: 'T', status: 'todo' })
    await exportTasks(plugin, project, [t.id])
    const key = taskExt(must(findTask(project.tasks, t.id))).key ?? ''

    deleteTaskFromTree(project.tasks, t.id) // deleted WITHOUT ignoring the key
    const r = await runSync(plugin, project)
    expect(r.newIssues.map((i) => i.key)).toContain(key) // the bounce-back the hook prevents
  })
})
