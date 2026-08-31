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
}

/**
 * One row: `- <status icon> <title> [<key>](<url>) _(due)_ — <assignees>`.
 *
 * A heading row is a project: it has no status, no dates and nobody assigned, so it gets
 * its title and its own badge and nothing else. Rendering the empty fields would put a
 * row of blanks above every group.
 */
function lineOf(row: FlatTask, opts: OutlineOpts): string {
  const task = row.task
  const indent = '    '.repeat(row.depth)
  const badges = opts
    .badgesOf(task)
    .map((b) => (b.href ? ` [${b.label}](${b.href})` : ` [${b.label}]`))
    .join('')
  if (opts.isHeading?.(task)) return `${indent}- **${task.title}**${badges}`

  const icon = getStatusConfig(opts.statuses, task.status)?.icon
  const symbol = icon ? `${icon} ` : ''
  const due = task.due ? ` _(${task.due})_` : ''
  const display = opts.displayName ?? ((n: string): string => n)
  const who = task.assignees.length ? ` — ${task.assignees.map(display).join(', ')}` : ''
  return `${indent}- ${symbol}${task.title}${badges}${due}${who}`
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
export function collapseParents(rows: FlatTask[], isHeading?: (task: Task) => boolean): FlatTask[] {
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
  return withRows.map((row) => ({ ...row, depth: depthOf(row) }))
}

/** The rows as a Markdown outline, in the order given. */
export function outlineMarkdown(rows: FlatTask[], opts: OutlineOpts): string {
  return rows.map((row) => lineOf(row, opts)).join('\n')
}
