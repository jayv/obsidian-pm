/**
 * The `pm-tasks` code block: a saved view from the all-projects timeline, rendered as a
 * panel inside any note (a homepage, a daily note).
 *
 * It deliberately owns no filtering of its own. The block names one of the saved views the
 * all-projects view already persists, and the tasks are selected with `matchesFilter` —
 * the same predicate the views use. So "my tasks this week" is whatever you defined it to
 * be over there, and the panel can never drift from the chart it mirrors.
 *
 * This half is pure: parsing and selection, no DOM.
 */
import type { FilterState, Project, SavedView, StatusConfig, Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { matchesFilter } from '../store/TaskFilter'

/** Filter state key of the all-projects view — see UberProjectView. */
export const UBER_FILTER_KEY = '::all-projects'

export interface TasksBlockSpec {
  /** Name of the saved view to mirror (required). */
  view: string
  /** Group rows under their project (default) or list them flat. */
  group: 'project' | 'none'
  /** Cap the number of rows; 0 = no cap. */
  limit: number
  /** Panel heading; defaults to the view's name. */
  title: string
  /** Anything the block asked for that we don't understand — surfaced, never ignored. */
  errors: string[]
}

const KEYS = new Set(['view', 'group', 'limit', 'title'])

/**
 * Parse the block body: one `key: value` per line, `#` comments, blanks ignored.
 *
 * Deliberately not YAML. The body is a handful of scalars, and a real parser would accept
 * shapes this can't act on — a nested map or a list would parse cleanly and then be
 * silently dropped, which is worse than saying "I don't know that key".
 */
export function parseTasksBlock(source: string): TasksBlockSpec {
  const spec: TasksBlockSpec = { view: '', group: 'project', limit: 0, title: '', errors: [] }
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 0) {
      spec.errors.push(`"${line}" is not \`key: value\``)
      continue
    }
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!KEYS.has(key)) {
      spec.errors.push(`unknown option "${key}" (expected: ${[...KEYS].join(', ')})`)
      continue
    }
    if (key === 'view') spec.view = value
    else if (key === 'title') spec.title = value
    else if (key === 'group') {
      if (value === 'project' || value === 'none') spec.group = value
      else spec.errors.push(`group must be "project" or "none", not "${value}"`)
    } else if (key === 'limit') {
      const n = Number(value)
      if (Number.isInteger(n) && n >= 0) spec.limit = n
      else spec.errors.push(`limit must be a whole number, not "${value}"`)
    }
  }
  if (!spec.view) spec.errors.push('no `view:` given — name a saved view from the all-projects timeline')
  return spec
}

/** The saved views the all-projects view has persisted, in their stored order. */
export function uberSavedViews(projectFilters: Record<string, { savedViews?: SavedView[] }> | undefined): SavedView[] {
  return projectFilters?.[UBER_FILTER_KEY]?.savedViews ?? []
}

/** Find a saved view by name, case-insensitively — the block names it as the user typed it. */
export function findSavedView(views: SavedView[], name: string): SavedView | undefined {
  const wanted = name.trim().toLowerCase()
  return views.find((v) => v.name.trim().toLowerCase() === wanted)
}

export interface BlockRow {
  project: Project
  task: Task
}

/**
 * Every task across `projects` the filter accepts, flattened (a matching subtask counts on
 * its own) and ordered by due date — undated last, since a panel is a list of what is
 * coming up and a task with no date isn't.
 */
export function selectBlockTasks(
  projects: Project[],
  filter: FilterState,
  statuses: StatusConfig[],
  limit = 0
): BlockRow[] {
  const rows: BlockRow[] = []
  for (const project of projects) {
    for (const { task } of flattenTasks(project.tasks)) {
      if (matchesFilter(task, filter, statuses)) rows.push({ project, task })
    }
  }
  rows.sort((a, b) => {
    const ad = a.task.due || ''
    const bd = b.task.due || ''
    if (ad !== bd) {
      if (!ad) return 1
      if (!bd) return -1
      return ad < bd ? -1 : 1
    }
    return a.task.title.localeCompare(b.task.title)
  })
  return limit > 0 ? rows.slice(0, limit) : rows
}

/** Rows grouped under their project, preserving the order projects were loaded in. */
export function groupByProject(rows: BlockRow[]): { project: Project; tasks: Task[] }[] {
  const out: { project: Project; tasks: Task[] }[] = []
  const index = new Map<string, { project: Project; tasks: Task[] }>()
  for (const { project, task } of rows) {
    let group = index.get(project.id)
    if (!group) {
      group = { project, tasks: [] }
      index.set(project.id, group)
      out.push(group)
    }
    group.tasks.push(task)
  }
  return out
}
