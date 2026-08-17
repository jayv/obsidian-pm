import { afterEach, describe, expect, it } from 'vitest'
import { findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, mutateMock, readMock, setDefaultMaps } from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { taskExt } from './types'
import { diagnoseAccess, exportTasks, makeClient, runSync } from './sync'

/*
 * Regressions for the ways a REAL Jira instance differs from the happy-path mock. Every
 * case here shipped as a live bug that the suite missed, because the mock had been
 * written to match the connector's assumptions rather than Jira's behaviour:
 *   - a project whose scheme allows only some of the instance's priorities
 *   - a project with no "Start date" field at all
 *   - a "Start date" that createmeta doesn't list but the field catalogue does
 * The issue-type hierarchy case (same type names at different levels across projects)
 * is guarded by the mock's FOREIGN_ISSUE_TYPES, in sync.test.ts.
 */
afterEach(() => stopMockServer())

const EPIC = 'DEMO-100'

describe('jira instance shape — priority schemes [O→J]', () => {
  it('offers only the priorities the project scheme allows, not the whole instance', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project) // seed the epic + register instance priorities
    await mutateMock(plugin, (s) => {
      for (const name of ['Critical', 'High', 'Medium', 'Low']) s.registerPriority(name)
      s.setPriorityScheme(['High', 'Low']) // this project accepts only two of them
    })

    const client = must(makeClient(plugin, project))
    const scoped = (await client.priorities(cfg.epicId)).map((p) => p.name).sort()
    expect(scoped).toEqual(['High', 'Low'])
    expect(scoped).not.toContain('Critical') // known instance-wide, invalid here

    // The instance-wide list is what we used to map from — it still reports all of them,
    // which is exactly how the invalid value got written.
    const instanceWide = (await client.priorities()).map((p) => p.name)
    expect(instanceWide).toContain('Critical')
  })

  it('surfaces a scheme-invalid priority as a held conflict instead of losing the task', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)
    await mutateMock(plugin, (s) => {
      for (const name of ['Critical', 'High']) s.registerPriority(name)
      s.setPriorityScheme(['High']) // "Critical" is instance-wide but rejected here
    })

    const t = localTask(project, { title: 'Urgent', priority: 'critical' })
    const { created } = await exportTasks(plugin, project, [t.id])

    // Jira refuses the create; the task must stay unlinked rather than silently vanish.
    expect(created).toBe(0)
    expect(taskExt(must(findTask(project.tasks, t.id))).key).toBeUndefined()
  })
})

describe('jira instance shape — the "Start date" field [O→J]', () => {
  it('holds the start date (never advances the shadow) when the project has no such field', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    // Before the first sync: the discovered id is cached per site for the session, so a
    // project that never had the field must be shaped that way from the start.
    await mutateMock(plugin, (s) => s.setStartFieldId('')) // no Start date anywhere
    await runSync(plugin, project)

    const t = localTask(project, { title: 'Dated', start: '2026-08-17', due: '2026-08-20' })
    await exportTasks(plugin, project, [t.id])
    const after = must(findTask(project.tasks, t.id))

    // Linked, but the unwritable start must stay pending — recording it as synced is how
    // the change got silently lost live.
    expect(taskExt(after).key).toBeTruthy()
    expect(taskExt(after).shadow?.start).toBe('')
    expect(after.start).toBe('2026-08-17') // kept locally
  })

  it('writes the start date once the project has the field', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const t = localTask(project, { title: 'Dated', start: '2026-08-17', due: '2026-08-20' })
    await exportTasks(plugin, project, [t.id])

    const mock = await readMock(plugin)
    const issue = mock.getIssue(must(taskExt(t).key))
    expect(issue?.fields[mock.startFieldId]).toBe('2026-08-17')
    expect(taskExt(must(findTask(project.tasks, t.id))).shadow?.start).toBe('2026-08-17')
  })
})

describe('jira instance shape — access diagnosis [setup]', () => {
  it('reports the account and its project permissions', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    setDefaultMaps(cfg)
    await runSync(plugin, project)

    const d = must(await diagnoseAccess(plugin, project))
    expect(d.projectKey).toBe(projectOf(EPIC))
    expect(d.error).toBeUndefined()
    expect(d.permissions?.CREATE_ISSUES).toBe(true)
    expect(d.permissions?.BROWSE_PROJECTS).toBe(true)
  })

  it('returns null when the project is not connected', async () => {
    const { plugin } = harness()
    const { project, cfg } = connect(plugin)
    cfg.enabled = false
    expect(await diagnoseAccess(plugin, project)).toBeNull()
  })
})

const projectOf = (key: string): string => key.split('-')[0]
