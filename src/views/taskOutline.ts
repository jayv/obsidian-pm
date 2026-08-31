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

/** The rows as a Markdown outline, in the order given. */
export function outlineMarkdown(rows: FlatTask[], opts: OutlineOpts): string {
  return rows.map((row) => lineOf(row, opts)).join('\n')
}
