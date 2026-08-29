/**
 * The `pm-tasks` code block: a saved view rendered as a panel inside any note (a homepage,
 * a daily note).
 *
 * It owns no filtering of its own. The block names a saved view — one of a project's own,
 * or one belonging to the all-projects timeline — and selects with `matchesFilter`, the
 * same predicate the views use. So "my tasks this week" is whatever you defined it to be
 * over there, and the panel can never drift from the view it mirrors.
 *
 * This half is pure: parsing, resolution and selection, no DOM.
 */
import { UBER_FILTER_KEY, type FilterState, type Project, type SavedView, type StatusConfig, type Task } from '../types'
import { matchesFilter } from '../store/TaskFilter'

export interface TasksBlockSpec {
  /**
   * Which project's saved views to look in, by title or note path. Omitted = the
   * all-projects timeline, whose views live in settings because it has no file.
   */
  project: string
  /** Name of the saved view to mirror. Optional only when a project is named. */
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

const KEYS = new Set(['project', 'view', 'group', 'limit', 'title'])

/**
 * Parse the block body: one `key: value` per line, `#` comments, blanks ignored.
 *
 * Deliberately not YAML. The body is a handful of scalars, and a real parser would accept
 * shapes this can't act on — a nested map or a list would parse cleanly and then be
 * silently dropped, which is worse than saying "I don't know that key".
 */
export function parseTasksBlock(source: string): TasksBlockSpec {
  const spec: TasksBlockSpec = { project: '', view: '', group: 'project', limit: 0, title: '', errors: [] }
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
    else if (key === 'project') spec.project = value
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

/** A filter that keeps everything — a project named with no view shows all of its work. */
export function matchAllFilter(): FilterState {
  return {
    text: '',
    statuses: [],
    priorities: [],
    assignees: [],
    tags: [],
    dueDateFilter: 'any',
    activeWeeks: [],
    showArchived: false
  }
}

export interface ResolvedBlock {
  /** The projects to scan: one when the block names it, otherwise all of them. */
  projects: Project[]
  filter: FilterState
  title: string
  errors: string[]
  /** Valid names for whatever the block got wrong, so the panel can say what to type. */
  available: string[]
}

/**
 * Work out what a block is asking for. Saved views belong to a project, so `project:`
 * chooses the namespace as well as the scope; without it the block reads the all-projects
 * timeline's views (kept in settings — that view is fileless and has nowhere else to put
 * them) and scans everything.
 */
export function resolveBlock(
  spec: TasksBlockSpec,
  allProjects: Project[],
  projectFilters: Record<string, { savedViews?: SavedView[] }> | undefined
): ResolvedBlock {
  const errors = [...spec.errors]
  let projects = allProjects
  let views = uberSavedViews(projectFilters)

  if (spec.project) {
    const wanted = spec.project.trim().toLowerCase()
    const found = allProjects.find(
      (p) => p.title.trim().toLowerCase() === wanted || p.filePath.toLowerCase() === wanted
    )
    if (!found) {
      return {
        projects: [],
        filter: matchAllFilter(),
        title: spec.title,
        errors: [...errors, `no project named "${spec.project}"`],
        available: allProjects.map((p) => p.title)
      }
    }
    projects = [found]
    views = found.savedViews
  }

  if (spec.view) {
    const saved = findSavedView(views, spec.view)
    if (!saved) {
      return {
        projects: [],
        filter: matchAllFilter(),
        title: spec.title,
        errors: [...errors, `no saved view named "${spec.view}"`],
        available: views.map((v) => v.name)
      }
    }
    return { projects, filter: saved.filter, title: spec.title || saved.name, errors, available: [] }
  }

  // No view named. Fine when a project is: that's "everything in this project".
  if (!spec.project) {
    return {
      projects: [],
      filter: matchAllFilter(),
      title: spec.title,
      errors: [...errors, 'name a `view:` (and optionally a `project:`)'],
      available: views.map((v) => v.name)
    }
  }
  return { projects, filter: matchAllFilter(), title: spec.title || projects[0].title, errors, available: [] }
}

export interface BlockRow {
  project: Project
  task: Task
  /** Nesting level among the rows that survived — 0 for a row with no listed parent. */
  depth: number
}

/** A kept task with the kept tasks under it. */
interface KeptNode {
  task: Task
  children: KeptNode[]
}

/**
 * Keep the tasks the filter accepts, minus container rows.
 *
 * A task that has sub-tasks is only worth a row when some of that work is on the list
 * too: on its own it is a heading, and a panel of headings is not a list of what to do.
 * So a parent survives only if something beneath it did — applied bottom-up, so a parent
 * whose only surviving child is itself a dropped container goes as well.
 *
 * A surviving task whose parent was dropped is lifted rather than lost: it matched, and
 * the reason its parent isn't shown has nothing to do with it.
 */
function keep(tasks: Task[], filter: FilterState, statuses: StatusConfig[]): KeptNode[] {
  const out: KeptNode[] = []
  for (const task of tasks) {
    const children = keep(task.subtasks, filter, statuses)
    const matches = matchesFilter(task, filter, statuses)
    if (!task.subtasks.length) {
      if (matches) out.push({ task, children: [] })
    } else if (matches && children.length) {
      out.push({ task, children })
    } else {
      out.push(...children) // parent not shown; its survivors stand on their own
    }
  }
  return out
}

/** Due date first (undated last — a panel is what's coming up), then title. */
function byDueThenTitle(a: KeptNode, b: KeptNode): number {
  const ad = a.task.due || ''
  const bd = b.task.due || ''
  if (ad !== bd) {
    if (!ad) return 1
    if (!bd) return -1
    return ad < bd ? -1 : 1
  }
  return a.task.title.localeCompare(b.task.title)
}

/** Depth-first, siblings sorted, so a parent always sits directly above its own rows. */
function flattenKept(nodes: KeptNode[], project: Project, depth: number, rows: BlockRow[]): void {
  for (const node of [...nodes].sort(byDueThenTitle)) {
    rows.push({ project, task: node.task, depth })
    flattenKept(node.children, project, depth + 1, rows)
  }
}

/**
 * Every task across `projects` the filter accepts, as rows ordered by due date within each
 * level. Ordering is per level rather than global so a kept parent stays attached to its
 * own sub-tasks — the rows only read as a hierarchy if they are adjacent.
 */
export function selectBlockTasks(
  projects: Project[],
  filter: FilterState,
  statuses: StatusConfig[],
  limit = 0
): BlockRow[] {
  const rows: BlockRow[] = []
  for (const project of projects) {
    flattenKept(keep(project.tasks, filter, statuses), project, 0, rows)
  }
  return limit > 0 ? rows.slice(0, limit) : rows
}

/** Rows grouped under their project, preserving the order projects were loaded in. */
export function groupByProject(rows: BlockRow[]): { project: Project; rows: BlockRow[] }[] {
  const out: { project: Project; rows: BlockRow[] }[] = []
  const index = new Map<string, { project: Project; rows: BlockRow[] }>()
  for (const row of rows) {
    let group = index.get(row.project.id)
    if (!group) {
      group = { project: row.project, rows: [] }
      index.set(row.project.id, group)
      out.push(group)
    }
    group.rows.push(row)
  }
  return out
}
