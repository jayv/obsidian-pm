import { afterEach, describe, expect, it } from 'vitest'
import { findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, readMock, setDefaultMaps } from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { CONFIG_PROP, ISSUE_PROP, projectCfg, taskExt } from './types'
import { cleanJira, exportTasks, runSync } from './sync'

// 'Clean Jira': wipe every plugin trace from the Jira side (per-issue obsidian-pm bag +
// the epic's obsidian-pm-config), then fully disconnect locally — without touching issues.
afterEach(() => stopMockServer())

const EPIC = 'DEMO-100'

describe('jira clean (cleanJira) [both]', () => {
  it('deletes issue + epic properties, keeps the issues, and resets all local state', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    cfg.mappingsDirty = true // so export writes obsidian-pm-config onto the epic
    await runSync(plugin, project) // seed the epic
    const ms = localTask(project, { title: 'Cut-off', type: 'milestone' })
    await exportTasks(plugin, project, [ms.id])
    const key = must(taskExt(ms).key)

    // Sanity: the metadata is present before cleaning.
    let mock = await readMock(plugin)
    expect(mock.getProperty(key, ISSUE_PROP)).toBeDefined()
    expect(mock.getProperty(EPIC, CONFIG_PROP)).toBeDefined()

    const res = await cleanJira(plugin, project)
    expect(res).toEqual({ cleaned: 1, failed: 0, epic: true })

    // Remote: properties gone, but the issue itself survives.
    mock = await readMock(plugin)
    expect(mock.getProperty(key, ISSUE_PROP)).toBeUndefined()
    expect(mock.getProperty(EPIC, CONFIG_PROP)).toBeUndefined()
    expect(mock.getIssue(key)).toBeTruthy()
    expect(mock.getIssue(EPIC)).toBeTruthy()

    // Local: config cleared and the task's Jira link stripped — a clean slate.
    expect(projectCfg(project)).toBeUndefined()
    expect(taskExt(must(findTask(project.tasks, ms.id))).key).toBeUndefined()
  })

  it('returns null when the project is not connected', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    cfg.enabled = false
    expect(await cleanJira(plugin, project)).toBeNull()
  })
})
