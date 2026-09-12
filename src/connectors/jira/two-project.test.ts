import { afterEach, describe, expect, it } from 'vitest'
import { findTask } from '../../store/TaskTreeOps'
import { connect, harness, localTask, must, rewind, setDefaultMaps } from './test-harness'
import { stopMockServer } from './JiraMockServer'
import { taskExt } from './types'
import { exportTasks, fetchEpicStories, hasConflicts, importStories, resolveConflict, runSync } from './sync'

afterEach(() => stopMockServer())

/**
 * Two Obsidian projects (A and B) on ONE plugin syncing the SAME backend issue —
 * the setup the user validates conflict resolution with. Each project keeps its own
 * per-task shadow, so a conflict only fires when both diverge from the SAME baseline
 * before either re-syncs.
 */
async function twoProjects() {
  const { plugin } = harness()
  const { project: projA, cfg: cfgA } = connect(plugin, { title: 'A' })
  setDefaultMaps(cfgA)
  const ax = localTask(projA, { title: 'Shared', start: '2026-01-01' })
  await exportTasks(plugin, projA, [ax.id])
  await runSync(plugin, projA)
  const { project: projB, cfg: cfgB } = connect(plugin, { title: 'B' })
  setDefaultMaps(cfgB)
  await importStories(plugin, projB, await fetchEpicStories(plugin, projB))
  const bx = must(findTask(projB.tasks, projB.tasks[0].id))
  return { plugin, projA, cfgA, ax, projB, cfgB, bx }
}

describe('jira sync — two projects, one backend issue [both]', () => {
  it('both edit the same field from a shared baseline → sync A then B flags a conflict', async () => {
    const { plugin, projA, ax, projB, bx } = await twoProjects()
    ax.start = '2026-02-02'
    bx.start = '2026-03-03'
    rewind(projA)
    await runSync(plugin, projA) // A pushes its value to JIRA first
    rewind(projB)
    const rb = await runSync(plugin, projB)
    expect(rb.conflicts).toBe(1) // B diverged from the same baseline → conflict
    expect(taskExt(must(findTask(projB.tasks, bx.id))).reconciled).toBe(false)

    // The merge editor opens off this: the project reports a conflict, and resolving
    // it (take Jira's value) clears the flag so the editor's list empties.
    expect(hasConflicts(projB)).toBe(true)
    await resolveConflict(plugin, projB, must(findTask(projB.tasks, bx.id)), ['start'])
    expect(hasConflicts(projB)).toBe(false)
    expect(must(findTask(projB.tasks, bx.id)).start).toBe('2026-02-02') // adopted A's value
  })

  it('if B re-syncs first it adopts A’s value, so a later B edit is a clean push (no conflict)', async () => {
    const { plugin, projA, ax, projB, bx } = await twoProjects()
    ax.start = '2026-02-02'
    rewind(projA)
    await runSync(plugin, projA) // JIRA = 02-02

    rewind(projB)
    const adopt = await runSync(plugin, projB) // B has no local edit → adopts 02-02 as its new baseline
    expect(adopt.conflicts).toBe(0)
    expect(must(findTask(projB.tasks, bx.id)).start).toBe('2026-02-02')

    const bAfter = must(findTask(projB.tasks, bx.id))
    bAfter.start = '2026-03-03' // now B edits from a baseline that already saw A's value
    rewind(projB)
    const rb = await runSync(plugin, projB)
    expect(rb.conflicts).toBe(0) // one-sided change → push, not a conflict
    expect(rb.jiraUpdated).toBe(1)
  })
})
