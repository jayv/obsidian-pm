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
import type { FlatTask } from '../store/TaskTreeOps'
import type { StatusConfig, Task } from '../types'
import { getStatusConfig } from '../utils'

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
