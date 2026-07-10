import { afterEach, describe, expect, it } from 'vitest'
import { findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, optIn, readMock, setDefaultMaps } from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { taskExt } from './types'
import { exportTasks, loadMappingValues, makeClient, runSync } from './sync'

// The connector persists the Jira-side id (priority id / status id) in the ext.jira
// value maps and prefers it over the display name on outbound writes — robust against
// renames and duplicate names. These tests prove discovery→persistence and id-based writes.
afterEach(() => stopMockServer())

describe('jira id mapping — persisted ids [O→J]', () => {
  it('loadMappingValues persists Jira ids for statuses and priorities', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    await loadMappingValues(plugin, project)
    expect(cfg.priorityMap.length).toBeGreaterThan(0)
    expect(cfg.statusMap.length).toBeGreaterThan(0)
    // Every discovered rule carries the Jira-side id, ready for id-based writes.
    expect(cfg.priorityMap.every((e) => Boolean(e.id))).toBe(true)
    expect(cfg.statusMap.every((e) => Boolean(e.id))).toBe(true)
  })

  it('pushes priority by id — resolves even when the stored name is stale', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    await loadMappingValues(plugin, project) // discovers + persists priority ids
    const high = must(cfg.priorityMap.find((e) => e.target === 'high' && e.id))
    // Simulate a priority renamed in Jira: keep the id, corrupt the stored name. An
    // id-based write still resolves; a name-based one would create a "STALE NAME" priority.
    cfg.priorityMap = [{ jira: 'STALE NAME', target: 'high', outbound: true, id: high.id }]
    const t = optIn(localTask(project, { title: 'T', priority: 'high' }))
    await runSync(plugin, project)

    const key = taskExt(must(findTask(project.tasks, t.id))).key ?? ''
    const issue = must((await readMock(plugin)).getIssue(key))
    const priority = issue.fields.priority as { id: string; name: string }
    expect(priority.id).toBe(high.id)
    expect(priority.name).toBe(high.jira) // the real name, resolved by id — not "STALE NAME"
  })

  it('transitionTo matches by status id even when the given name is wrong', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    const t = localTask(project, { title: 'T', status: 'todo' })
    await exportTasks(plugin, project, [t.id]) // creates the issue + starts the mock
    const key = taskExt(must(findTask(project.tasks, t.id))).key ?? ''
    const client = must(makeClient(plugin, project))
    const done = must((await readMock(plugin)).data.meta.statuses.find((s) => s.name === 'Done'))

    expect(await client.transitionTo(key, 'WRONG NAME', done.id)).toBe(true) // matched by id
    expect((await client.getIssue(key))?.status).toBe('Done')
    expect(await client.transitionTo(key, 'WRONG NAME')).toBe(false) // no id + no name match → no transition
  })
})
