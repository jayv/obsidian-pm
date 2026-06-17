import type { StatusConfig, Task } from '../../types'
import type { FlatTask } from '../../store/TaskTreeOps'
import { isTerminalStatus, formatDateShort } from '../../utils'
import { displayName } from '../../ui/primitives/Avatar'

/** Conflict overlay data for a single task bar. */
export interface TaskConflicts {
  /** Merged date ranges (inclusive ISO YYYY-MM-DD) where the bar overlaps a same-assignee task. */
  segments: { start: string; end: string }[]
  /** Raw assignee names that are over-allocated on this task (for the avatar ring). */
  assignees: Set<string>
  /** One line per conflicting (assignee, partner task) pair, for the tooltip. */
  notes: string[]
}

/**
 * Find resource-allocation conflicts among the rendered tasks: for each
 * assignee, any two of their tasks whose date ranges overlap. Only leaf tasks
 * (real work) with both dates that aren't milestones or done/cancelled count —
 * summary rows derive their span from children and would double-book.
 */
export interface ConflictResult {
  /** Per-task overlay data, keyed by task id. */
  byTask: Map<string, TaskConflicts>
  /** Number of distinct double-booking incidents (one per overlapping assignee-task pair). */
  count: number
}

export function computeResourceConflicts(flat: FlatTask[], statuses: StatusConfig[]): ConflictResult {
  const eligible = flat
    .map((f) => f.task)
    .filter(
      (t) =>
        t.subtasks.length === 0 &&
        t.type !== 'milestone' &&
        !isTerminalStatus(t.status, statuses) &&
        Boolean(t.start) &&
        Boolean(t.due)
    )

  const byAssignee = new Map<string, Task[]>()
  for (const t of eligible) {
    for (const a of t.assignees) {
      const list = byAssignee.get(a)
      if (list) list.push(t)
      else byAssignee.set(a, [t])
    }
  }

  const result = new Map<string, TaskConflicts>()
  const entryFor = (id: string): TaskConflicts => {
    let e = result.get(id)
    if (!e) {
      e = { segments: [], assignees: new Set(), notes: [] }
      result.set(id, e)
    }
    return e
  }

  let count = 0
  for (const [assignee, tasks] of byAssignee) {
    if (tasks.length < 2) continue
    const sorted = [...tasks].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    const who = displayName(assignee)
    // ISO YYYY-MM-DD strings compare correctly lexically.
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]
        if (b.start > a.due) break // sorted by start: no later task can overlap a
        const oStart = a.start > b.start ? a.start : b.start
        const oEnd = a.due < b.due ? a.due : b.due
        if (oStart > oEnd) continue
        count++
        const range = `${formatDateShort(oStart)}–${formatDateShort(oEnd)}`
        const ea = entryFor(a.id)
        ea.segments.push({ start: oStart, end: oEnd })
        ea.assignees.add(assignee)
        ea.notes.push(`${who} · overlaps “${b.title}” (${range})`)
        const eb = entryFor(b.id)
        eb.segments.push({ start: oStart, end: oEnd })
        eb.assignees.add(assignee)
        eb.notes.push(`${who} · overlaps “${a.title}” (${range})`)
      }
    }
  }

  for (const e of result.values()) e.segments = mergeRanges(e.segments)
  return { byTask: result, count }
}

/** Merge overlapping/adjacent inclusive date ranges so the hatch is continuous. */
function mergeRanges(ranges: { start: string; end: string }[]): { start: string; end: string }[] {
  if (ranges.length < 2) return ranges
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const merged = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const cur = sorted[i]
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end
    } else {
      merged.push(cur)
    }
  }
  return merged
}
