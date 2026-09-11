import type PMPlugin from '../../main'
import type { Project, Task } from '../../types'
import { openTaskModal } from '../../ui/ModalFactory'

/** The slice of either Gantt context this needs — both the label and bar contexts fit. */
interface OpenRowCtx {
  plugin: PMPlugin
  onRefresh: () => Promise<void>
  /** First refusal on opening a row. See LabelContext.onOpenTask. */
  onOpenTask?: (task: Task) => boolean
}

/**
 * Open a row, giving the host first refusal.
 *
 * Every way into a row has to ask `onOpenTask` before falling back to the task editor: the
 * all-projects view uses it for its project heading rows, which are Task objects but
 * aren't tasks, and answering with a task editor for a synthetic task is never right.
 *
 * One function because there are three ways in — the tree label, the bar, and a milestone
 * diamond — and only the label was asking. Clicking a project in the tree opened the
 * project while clicking its bar two inches to the right opened a fake task.
 */
export function openRow(task: Task, owner: Project, ctx: OpenRowCtx): void {
  if (ctx.onOpenTask?.(task)) return
  openTaskModal(ctx.plugin, owner, { task, onSave: () => ctx.onRefresh() })
}
