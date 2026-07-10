import { parsePlainDate, Temporal, today } from '../dates'
import type { DueDateFilter, FilterState, StatusConfig, Task } from '../types'
import { isTerminalStatus } from '../utils'
import type { FlatTask } from './TaskTreeOps'

export function isFilterActive(filter: FilterState): boolean {
  return !!(
    filter.text ||
    filter.statuses.length ||
    filter.priorities.length ||
    filter.assignees.length ||
    filter.tags.length ||
    filter.dueDateFilter !== 'any' ||
    filter.activeThisWeek
  )
}

/**
 * A copy with all arrays cloned, so nothing (a saved view, persisted settings) ever shares
 * array refs with the live filter — the UI mutates the live filter's arrays in place.
 * Spread-then-clone so any future scalar field is carried automatically, not dropped.
 */
export function cloneFilter(f: FilterState): FilterState {
  return {
    ...f,
    statuses: [...f.statuses],
    priorities: [...f.priorities],
    assignees: [...f.assignees],
    tags: [...f.tags]
  }
}

/** Value-equality of two filters (list fields compared as unordered sets). */
export function filterEquals(a: FilterState, b: FilterState): boolean {
  const setEq = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((v) => y.includes(v))
  return (
    a.text === b.text &&
    a.dueDateFilter === b.dueDateFilter &&
    a.activeThisWeek === b.activeThisWeek &&
    a.showArchived === b.showArchived &&
    setEq(a.statuses, b.statuses) &&
    setEq(a.priorities, b.priorities) &&
    setEq(a.assignees, b.assignees) &&
    setEq(a.tags, b.tags)
  )
}

export function countActiveFilters(filter: FilterState): number {
  let count = 0
  if (filter.text) count++
  if (filter.statuses.length) count++
  if (filter.priorities.length) count++
  if (filter.assignees.length) count++
  if (filter.tags.length) count++
  if (filter.dueDateFilter !== 'any') count++
  if (filter.activeThisWeek) count++
  if (filter.showArchived) count++
  return count
}

/**
 * Match the search query against string values one level into a task's connector `ext`
 * bag (e.g. ext.jira.key = "ENG-123"). Connector-agnostic — any connector's string
 * fields become searchable, without the filter knowing about JIRA specifically.
 */
function extMatchesText(ext: Record<string, unknown> | undefined, q: string): boolean {
  if (!ext) return false
  for (const bag of Object.values(ext)) {
    if (!bag || typeof bag !== 'object') continue
    for (const v of Object.values(bag)) {
      if (typeof v === 'string' && v.toLowerCase().includes(q)) return true
    }
  }
  return false
}

export function matchesFilter(task: Task, filter: FilterState, statuses: StatusConfig[] = []): boolean {
  if (task.archived && !filter.showArchived) return false
  if (filter.text) {
    const q = filter.text.toLowerCase()
    if (
      !(
        task.title.toLowerCase().includes(q) ||
        task.status.includes(q) ||
        task.priority.includes(q) ||
        task.assignees.some((a) => a.toLowerCase().includes(q)) ||
        task.tags.some((t) => t.toLowerCase().includes(q)) ||
        extMatchesText(task.ext, q)
      )
    ) {
      return false
    }
  }
  if (filter.statuses.length && !filter.statuses.includes(task.status)) return false
  if (filter.priorities.length && !filter.priorities.includes(task.priority)) return false
  if (filter.assignees.length && !task.assignees.some((a) => filter.assignees.includes(a))) return false
  if (filter.tags.length && !task.tags.some((t) => filter.tags.includes(t))) return false
  if (filter.dueDateFilter !== 'any' && !matchDueDateFilter(task, filter.dueDateFilter, statuses)) return false
  if (filter.activeThisWeek && !overlapsCurrentWeek(task)) return false
  return true
}

/**
 * True when the task's span overlaps the current week (Mon–Sun). The span is
 * `[start…due]`, falling back to whichever single date exists (so a one-date task or a
 * milestone counts on its day). A task with no dates never overlaps.
 */
function overlapsCurrentWeek(task: Task): boolean {
  const start = parsePlainDate(task.start) ?? parsePlainDate(task.due)
  const end = parsePlainDate(task.due) ?? parsePlainDate(task.start)
  if (!start || !end) return false
  const now = today()
  const weekStart = now.subtract({ days: now.dayOfWeek - 1 })
  const weekEnd = weekStart.add({ days: 6 })
  // Overlap: the task starts on/before the week ends AND ends on/after the week starts.
  return Temporal.PlainDate.compare(start, weekEnd) <= 0 && Temporal.PlainDate.compare(end, weekStart) >= 0
}

export function applyTaskFilter(tasks: Task[], filter: FilterState, statuses: StatusConfig[] = []): Task[] {
  return tasks
    .filter((t) => matchesFilter(t, filter, statuses))
    .map((t) => (t.subtasks.length ? { ...t, subtasks: applyTaskFilter(t.subtasks, filter, statuses) } : t))
}

/**
 * Tree-shaped filter that lifts orphaned matching descendants to the slot of
 * their dropped ancestor. Used by the gantt view so a matching subtask doesn't
 * disappear when its parent doesn't match.
 */
export function applyTaskFilterPromote(tasks: Task[], filter: FilterState, statuses: StatusConfig[] = []): Task[] {
  const result: Task[] = []
  for (const t of tasks) {
    const filteredSubs = t.subtasks.length ? applyTaskFilterPromote(t.subtasks, filter, statuses) : []
    // A parent whose subtasks were all filtered out is dropped even if it matches:
    // in the gantt it would otherwise render as a lone normal bar (a summary with
    // nothing to summarize). Real leaves (no subtasks) that match are kept.
    const parentWithNoVisibleSubs = t.subtasks.length > 0 && filteredSubs.length === 0
    if (matchesFilter(t, filter, statuses) && !parentWithNoVisibleSubs) {
      result.push({ ...t, subtasks: filteredSubs })
    } else {
      result.push(...filteredSubs)
    }
  }
  return result
}

export function applyTaskFilterFlat(flat: FlatTask[], filter: FilterState, statuses: StatusConfig[] = []): FlatTask[] {
  return flat.filter(({ task }) => matchesFilter(task, filter, statuses))
}

function matchDueDateFilter(task: Task, filter: DueDateFilter, statuses: StatusConfig[]): boolean {
  if (filter === 'no-date') return !task.due
  const due = parsePlainDate(task.due)
  if (!due) return false
  const now = today()

  switch (filter) {
    case 'overdue':
      return Temporal.PlainDate.compare(due, now) < 0 && !isTerminalStatus(task.status, statuses)
    case 'this-week': {
      // The whole current week (Mon–Sun), not just today onward — so a task due
      // earlier this week (e.g. one already completed) still counts as "this week".
      const startOfWeek = now.subtract({ days: now.dayOfWeek - 1 })
      const endOfWeek = startOfWeek.add({ days: 6 })
      return Temporal.PlainDate.compare(due, startOfWeek) >= 0 && Temporal.PlainDate.compare(due, endOfWeek) <= 0
    }
    case 'this-month':
      // The whole current month, including days already past.
      return due.year === now.year && due.month === now.month
    default:
      return true
  }
}
