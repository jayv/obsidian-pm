/**
 * Copy a task tree as a Markdown outline.
 *
 * The per-project export groups leaf tasks by assignee, which is the right shape for a
 * status update about one project. Across every project that shape loses the thing you
 * came for — which project a task belongs to, and how the work nests — so this one mirrors
 * the chart's own tree instead: the rows the Gantt is showing, in its order, at its depth.
 *
 * It takes the rows rather than computing them, so it renders what is on screen by
 * construction. Re-deriving "visible" here would be a second implementation of filtering,
 * promotion and collapse, free to drift from the chart it claims to match.
 */
import { Temporal, parsePlainDate, today } from '../dates'
import { applyTaskFilterPromote, matchesFilter } from '../store/TaskFilter'
import { flattenTasks, type FlatTask } from '../store/TaskTreeOps'
import { buildUberProject, type UberProject } from '../store/UberProject'
import type { FilterState, Project, StatusConfig, Task } from '../types'
import { getStatusConfig, isTerminalStatus } from '../utils'

export interface OutlineOpts {
  statuses: StatusConfig[]
  /** Connector badges for a task, e.g. its Jira key — already resolved to its owner. */
  badgesOf: (task: Task) => { label: string; href?: string }[]
  /** True for a row that stands for a project rather than a task (the all-projects view). */
  isHeading?: (task: Task) => boolean
  /** Display form of an assignee name (initials roster, alias, …). */
  displayName?: (name: string) => string
  /** Row title, e.g. the "Parent > Child" path from {@link titlePaths}. */
  titleOf?: (task: Task) => string
  /**
   * Ids of tasks that are carried over from an earlier week (see {@link uberRows}). They
   * are listed under their project in their own group, after the assignee groups, with
   * the assignee on the line — the question they pose is "who still owes this", not
   * "what is X doing this week".
   */
  carried?: Set<string>
}

/**
 * One row: `- <status icon> <title> [<key>](<url>) _(due)_ — <assignees>`.
 *
 * A heading row is a project: it has no status, no dates and nobody assigned, so it gets
 * its title and its own badge and nothing else. Rendering the empty fields would put a
 * row of blanks above every group.
 */
function taskLine(task: Task, depth: number, opts: OutlineOpts, withAssignees = true): string {
  const title = opts.titleOf?.(task) ?? task.title
  const indent = indentOf(depth)
  const badges = opts
    .badgesOf(task)
    .map((b) => (b.href ? ` [${b.label}](${b.href})` : ` [${b.label}]`))
    .join('')
  if (opts.isHeading?.(task)) return `${indent}- **${title}**${badges}`

  const icon = getStatusConfig(opts.statuses, task.status)?.icon
  const symbol = icon ? `${icon} ` : ''
  const due = task.due ? ` _(${task.due})_` : ''
  // Dropped under an assignee heading: it has already said whose this is, and repeating
  // it on every line beneath is noise.
  const who = withAssignees && task.assignees.length ? ` — ${task.assignees.map(nameOf(opts)).join(', ')}` : ''
  return `${indent}- ${symbol}${title}${badges}${due}${who}`
}

const indentOf = (depth: number): string => '    '.repeat(depth)
const nameOf = (opts: OutlineOpts): ((n: string) => string) => opts.displayName ?? ((n: string): string => n)

/** Empty due dates sort after dated ones. */
function byDue(a: Task, b: Task): number {
  if (a.due === b.due) return 0
  if (!a.due) return 1
  if (!b.due) return -1
  return a.due.localeCompare(b.due)
}

/**
 * Tasks grouped under an assignee heading: `- @Name`, then their work indented beneath.
 *
 * The @-mention is the point — a pasted update pings the people in it. "Unassigned" is
 * nobody, so it stays styled rather than mentioned and sorts last; milestones are markers
 * rather than anyone's work, so they get their own group at the top.
 *
 * Shared by the per-project export and the all-projects one. They drifted apart while each
 * formatted its own version of the same thing, which is what having one format is for.
 */
export function assigneeOutline(tasks: Task[], opts: OutlineOpts, baseDepth = 0): string[] {
  const display = nameOf(opts)
  const whoOf = (t: Task): string => (t.assignees.length ? t.assignees.map(display).join(', ') : 'Unassigned')

  const milestones = tasks.filter((t) => t.type === 'milestone').sort(byDue)
  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    if (task.type === 'milestone') continue
    const key = whoOf(task)
    const arr = groups.get(key)
    if (arr) arr.push(task)
    else groups.set(key, [task])
  }
  // Named assignees alphabetically; "Unassigned" last — a leftover, not a person.
  const keys = [...groups.keys()].sort((a, b) => {
    if ((a === 'Unassigned') !== (b === 'Unassigned')) return a === 'Unassigned' ? 1 : -1
    return a.localeCompare(b)
  })

  const lines: string[] = []
  const emit = (header: string, items: Task[]): void => {
    lines.push(`${indentOf(baseDepth)}- ${header}`)
    for (const task of items) lines.push(taskLine(task, baseDepth + 1, opts, false))
  }
  if (milestones.length) emit('*Milestones*', milestones)
  for (const key of keys) {
    const items = (groups.get(key) ?? []).sort(byDue)
    const names = items[0].assignees.map(display)
    emit(names.length ? names.map((n) => `@${n}`).join(', ') : `*${key}*`, items)
  }
  return lines
}

/**
 * The all-projects shape: a project heading, then that project's rows grouped by
 * assignee beneath it. `rows` are the (already collapsed) rows in display order, project
 * headings included — the same loop the timeline's copy button runs, so an export made
 * without the view open cannot drift from the one made with it.
 */
export function projectOutline(rows: FlatTask[], opts: OutlineOpts): string[] {
  const lines: string[] = []
  let tasks: Task[] = []
  let carried: Task[] = []
  const flush = (): void => {
    if (tasks.length) lines.push(...assigneeOutline(tasks, opts, 1))
    if (carried.length) {
      lines.push(`${indentOf(1)}- *Carried over*`)
      for (const task of carried.sort(byDue)) lines.push(taskLine(task, 2, opts))
    }
    tasks = []
    carried = []
  }
  for (const row of rows) {
    if (opts.isHeading?.(row.task)) {
      flush()
      lines.push(outlineMarkdown([{ ...row, depth: 0 }], opts))
    } else if (opts.carried?.has(row.task.id)) {
      carried.push(row.task)
    } else {
      tasks.push(row.task)
    }
  }
  flush()
  return lines
}

export interface UberRows {
  uber: UberProject
  /** Collapsed rows with their paths, ready for {@link projectOutline}. */
  rows: FlatTask[]
  paths: Map<string, string>
  /** Ids of the carried-over rows; empty when none were asked for. */
  carried: Set<string>
  /** The Mon–Sun window the filter's weeks span, or null when it has no week filter. */
  week: { from: string; to: string } | null
}

/** Monday of the current week plus `offset` weeks. */
function weekStart(offset: number): Temporal.PlainDate {
  const now = today()
  return now.subtract({ days: now.dayOfWeek - 1 }).add({ days: offset * 7 })
}

/**
 * Unfinished work whose span ended in the `weeks` weeks before the filter's window, so it
 * no longer overlaps it and the week filter would hide it. Everything else about the
 * filter still applies (assignee, tags, text, statuses) — a "my work" view carries over
 * only my work. A terminal status is never carried: done is done.
 */
function carriedOver(tasks: Task[], filter: FilterState, statuses: StatusConfig[], weeks: number): Task[] {
  if (weeks <= 0) return []
  const offsets = filter.activeWeeks.length ? filter.activeWeeks : [0]
  const windowStart = weekStart(Math.min(...offsets))
  const from = windowStart.subtract({ days: weeks * 7 })
  const dateless: FilterState = { ...filter, activeWeeks: [], dueDateFilter: 'any' }
  const out: Task[] = []
  for (const { task } of flattenTasks(tasks)) {
    if (isTerminalStatus(task.status, statuses)) continue
    if (!matchesFilter(task, dateless, statuses)) continue
    const end = parsePlainDate(task.due) ?? parsePlainDate(task.start)
    if (!end) continue
    if (Temporal.PlainDate.compare(end, from) < 0 || Temporal.PlainDate.compare(end, windowStart) >= 0) continue
    // A parent is its sub-tasks' heading; the sub-tasks carry themselves.
    if (task.subtasks.length) continue
    out.push(task)
  }
  return out
}

/**
 * What the all-projects timeline would show for `filter`, without a view: each project's
 * tree filtered with promotion, the survivors assembled under project headings, parents
 * collapsed away. Branch collapse is UI state and is ignored — an export from the API
 * has no screen to mirror, so it lists everything the filter lets through.
 */
export function uberRows(
  sources: Project[],
  filter: FilterState,
  statuses: StatusConfig[],
  carryOverWeeks = 0
): UberRows {
  const shown = new Map<Project, Task[]>()
  const carried = new Set<string>()
  for (const source of sources) {
    const tasks = applyTaskFilterPromote(source.tasks, filter, statuses)
    const present = new Set(flattenTasks(tasks).map((f) => f.task.id))
    // Carried rows join the project as top-level leaves: the heading is still the
    // project's, and the "Parent > Child" path is kept by titlePaths over the real tree.
    for (const task of carriedOver(source.tasks, filter, statuses, carryOverWeeks)) {
      if (present.has(task.id)) continue
      carried.add(task.id)
      tasks.push({ ...task, subtasks: [] })
    }
    if (tasks.length) shown.set(source, tasks)
  }
  const uber = buildUberProject([...shown.keys()], (source) => shown.get(source) ?? [])
  const isHeading = (task: Task): boolean => uber.headings.has(task.id)
  const { rows, paths } = collapseParents(flattenTasks(uber.project.tasks), isHeading)
  // A carried row's path comes from its home tree, where its parents still are.
  for (const source of shown.keys()) {
    for (const [id, path] of titlePaths(flattenTasks(source.tasks))) if (carried.has(id)) paths.set(id, path)
  }
  let week: UberRows['week'] = null
  if (filter.activeWeeks.length) {
    const from = weekStart(Math.min(...filter.activeWeeks))
    const to = weekStart(Math.max(...filter.activeWeeks)).add({ days: 6 })
    week = { from: from.toString(), to: to.toString() }
  }
  return { uber, rows, paths, carried, week }
}

/**
 * "Parent > Child" for every row, from the ancestor chain as it stands BEFORE any parents
 * are collapsed away — the removed names are exactly the context a leaf would otherwise
 * lose. Project rows are not part of the path: the row above already names the project.
 *
 * Matches the per-project export, which prefixes an ancestor chain for the same reason.
 */
export function titlePaths(rows: FlatTask[], isHeading?: (task: Task) => boolean): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.task.id, r]))
  const paths = new Map<string, string>()
  for (const row of rows) {
    if (isHeading?.(row.task)) {
      paths.set(row.task.id, row.task.title)
      continue
    }
    const parts = [row.task.title]
    for (let pid = row.parentId; pid; ) {
      const parent = byId.get(pid)
      if (!parent || isHeading?.(parent.task)) break
      parts.unshift(parent.task.title)
      pid = parent.parentId
    }
    paths.set(row.task.id, parts.join(' > '))
  }
  return paths
}

/**
 * Drop a parent row when its own sub-tasks are in the list too, and re-seat what's left.
 *
 * A parent and its children both appearing says the same thing twice — the parent is a
 * heading, and the work is underneath it. So the parent goes and the sub-tasks stand on
 * their own. A task with no sub-tasks was never a parent and is always kept.
 *
 * The test is "are its sub-tasks actually here", not "does it have any". A branch the
 * chart has collapsed contributes only its parent row, and dropping that would export
 * nothing at all for it — less than the chart shows, and silently.
 *
 * Depth is recomputed from the rows that survived, so nothing is left indented under a
 * parent that isn't there any more.
 */
export interface CollapsedOutline {
  rows: FlatTask[]
  /**
   * "Parent > Child" per surviving row, taken before the collapse — so it still carries
   * the names of the parents that were just removed. Returned together with the rows
   * rather than left to the caller: computing it from the collapsed set instead would
   * silently produce bare titles, which is the whole thing the path exists to prevent.
   */
  paths: Map<string, string>
}

export function collapseParents(rows: FlatTask[], isHeading?: (task: Task) => boolean): CollapsedOutline {
  const paths = titlePaths(rows, isHeading)
  const present = new Set(rows.map((r) => r.task.id))
  const hasDescendantHere = (task: Task): boolean =>
    task.subtasks.some((sub) => present.has(sub.id) || hasDescendantHere(sub))

  const kept = rows.filter((r) => isHeading?.(r.task) || !r.task.subtasks.length || !hasDescendantHere(r.task))
  // A project row with nothing left under it is a bare title; drop it rather than export
  // a heading for work that isn't there.
  const withRows = kept.filter((r) => !isHeading?.(r.task) || hasDescendantHere(r.task))

  const byId = new Map(rows.map((r) => [r.task.id, r]))
  const keptIds = new Set(withRows.map((r) => r.task.id))
  const depthOf = (row: FlatTask): number => {
    let depth = 0
    for (let pid = row.parentId; pid; ) {
      const parent = byId.get(pid)
      if (!parent) break
      if (keptIds.has(pid)) depth++
      pid = parent.parentId
    }
    return depth
  }
  return { rows: withRows.map((row) => ({ ...row, depth: depthOf(row) })), paths }
}

/** The rows as a Markdown outline, in the order given. */
export function outlineMarkdown(rows: FlatTask[], opts: OutlineOpts): string {
  return rows.map((row) => taskLine(row.task, row.depth, opts)).join('\n')
}
