import { afterEach, describe, expect, it } from 'vitest'
import { findTask, flattenTasks } from '../../store/TaskTreeOps'
import {
  FUTURE,
  connect,
  harness,
  localTask,
  must,
  mustIssue,
  mutateMock,
  optIn,
  readMock,
  setDefaultMaps,
  statusObj
} from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { CONFIG_PROP, taskExt, type JiraEpicConfig } from './types'
import { exportTasks, runSync } from './sync'

// Incremental sync (`runSync(…, { full: false })`) is what the periodic tick uses:
// it pulls only the tracked subtree changed since the watermark (+ locally-dirty
// issues) and never re-pulls the shared epic config. These tests pin down that the
// cheap path still reconciles correctly and stays scoped.
afterEach(() => stopMockServer())

const EPIC = 'DEMO-100'

/** Project with one exported, in-sync task; watermark established. Returns its JIRA key. */
async function linked(plugin: ReturnType<typeof harness>['plugin']): Promise<{
  project: ReturnType<typeof connect>['project']
  cfg: ReturnType<typeof connect>['cfg']
  task: ReturnType<typeof localTask>
  key: string
}> {
  const { project, cfg } = connect(plugin)
  setDefaultMaps(cfg)
  const task = localTask(project, { title: 'T', status: 'todo' })
  await exportTasks(plugin, project, [task.id])
  await runSync(plugin, project) // full: establishes the watermark + epic config
  return { project, cfg, task, key: taskExt(task).key ?? '' }
}

describe('jira sync — incremental tick [J→O]', () => {
  it('adopts a teammate change to a tracked issue since the watermark', async () => {
    const { plugin } = harness()
    const { project, key } = await linked(plugin)
    await mutateMock(plugin, (s) => {
      const i = must(s.getIssue(key))
      i.fields.status = statusObj('Done', 'Done')
      i.fields.updated = FUTURE
    })
    const r = await runSync(plugin, project, { full: false })
    expect(r.obsidianUpdated).toBe(1)
    expect(must(findTask(project.tasks, flattenTasks(project.tasks)[0].task.id)).status).toBe('done')
  })

  it('pushes a locally-dirty task even when its JIRA side is unchanged', async () => {
    const { plugin } = harness()
    const { project, cfg, task, key } = await linked(plugin)
    // Local edit only — the JIRA issue keeps its `updated`, so the changed-subtree query
    // returns nothing; the dirty-key fetch (issuesByKeys) is the only way this syncs.
    task.title = 'Renamed locally'
    cfg.dirtyQueue = [task.id]
    const r = await runSync(plugin, project, { full: false })
    expect(r.jiraUpdated).toBe(1)
    expect(mustIssue(await readMock(plugin), key).fields.summary).toBe('Renamed locally')
  })

  it('detects a new child of the epic that appeared on the JIRA side', async () => {
    const { plugin } = harness()
    const { project } = await linked(plugin)
    await mutateMock(plugin, (s) => {
      const i = s.createIssue({ issuetype: { name: 'Task' }, summary: 'Fresh', parent: { key: EPIC } })
      i.fields.updated = FUTURE // ensure it lands past the watermark minute
    })
    const r = await runSync(plugin, project, { full: false })
    expect(r.newIssues.map((i) => i.summary)).toContain('Fresh')
  })

  it('detects a new child of a tracked task (subtree-scoped, not just the epic)', async () => {
    const { plugin } = harness()
    const { project, key } = await linked(plugin)
    await mutateMock(plugin, (s) => {
      const i = s.createIssue({ issuetype: { name: 'Sub-task' }, summary: 'Deep', parent: { key } })
      i.fields.updated = FUTURE
    })
    const r = await runSync(plugin, project, { full: false })
    expect(r.newIssues.map((i) => i.summary)).toContain('Deep')
  })

  it('still creates opted-in keyless tasks on an incremental tick', async () => {
    const { plugin } = harness()
    const { project } = await linked(plugin)
    const fresh = optIn(localTask(project, { title: 'born-on-tick' }))
    const r = await runSync(plugin, project, { full: false })
    expect(r.jiraCreated).toBe(1)
    expect(taskExt(must(findTask(project.tasks, fresh.id))).key).toBeTruthy()
  })

  it('does not pull the shared epic config on an incremental tick, but a full sync does', async () => {
    const { plugin } = harness()
    const { project, cfg } = await linked(plugin)
    // A teammate publishes a new status rule to the epic config directly.
    await mutateMock(plugin, (s) => {
      const remote = s.getProperty(EPIC, CONFIG_PROP) as JiraEpicConfig
      remote.statusMap.push({ jira: 'Backlog', target: 'todo', outbound: false })
      s.setProperty(EPIC, CONFIG_PROP, remote)
    })
    await runSync(plugin, project, { full: false })
    expect(cfg.statusMap.some((e) => e.jira === 'Backlog')).toBe(false) // tick skips the pull
    await runSync(plugin, project) // full sync adopts it
    expect(cfg.statusMap.some((e) => e.jira === 'Backlog')).toBe(true)
  })
})
