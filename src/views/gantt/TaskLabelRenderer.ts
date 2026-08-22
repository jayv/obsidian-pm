import type PMPlugin from '../../main'
import type { Project, Task, TaskBadge } from '../../types'
import { CollapseToggle } from '../../ui/primitives/CollapseToggle'
import { AvatarStack } from '../../ui/primitives/AvatarStack'
import { renderTaskBadges } from '../../ui/primitives/TaskBadges'
import { openTaskModal } from '../../ui/ModalFactory'
import { getStatusConfig, safeAsync } from '../../utils'
import { ROW_HEIGHT } from './TimelineConfig'

export interface LabelContext {
  plugin: PMPlugin
  project: Project
  onRefresh: () => Promise<void>
  /** Short labels (e.g. a linked issue key) to show beside the title, as in the table. */
  badgesOf?: (task: Task) => TaskBadge[]
  /** View-wide initials for avatars — see projectRoster. */
  roster?: Map<string, string>
  /** Render without any way to change a task: no reordering, no add-subtask button. */
  readOnly?: boolean
  /**
   * Which project actually owns a task. The cross-project view renders a virtual project
   * that isn't file-backed, so the task editor has to be bound to the real one or the
   * edit would look saved and go nowhere.
   */
  ownerOf?: (task: Task) => Project
}

export function renderTaskLabel(
  container: HTMLElement,
  task: Task,
  depth: number,
  _row: number,
  ctx: LabelContext
): void {
  const el = container.createDiv('pm-gantt-label-row')
  el.style.height = `${ROW_HEIGHT}px`
  el.style.paddingLeft = `${depth * 18 + 8}px`
  el.dataset.taskId = task.id

  const owner = ctx.ownerOf?.(task) ?? ctx.project

  // Make draggable for reordering
  el.draggable = !ctx.readOnly
  el.addEventListener('dragstart', (e: DragEvent) => {
    e.dataTransfer?.setData('text/plain', task.id)
    el.addClass('pm-gantt-label-row--dragging')
  })
  el.addEventListener('dragend', () => {
    el.removeClass('pm-gantt-label-row--dragging')
  })
  let dropPosition: 'before' | 'after' = 'before'
  // Reordering is a write, and across projects it has no meaning anyway.
  if (!ctx.readOnly) {
    el.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const midY = rect.top + rect.height / 2
      dropPosition = e.clientY < midY ? 'before' : 'after'
      el.removeClass('pm-gantt-label-row--drop-before', 'pm-gantt-label-row--drop-after')
      el.addClass(dropPosition === 'before' ? 'pm-gantt-label-row--drop-before' : 'pm-gantt-label-row--drop-after')
    })
    el.addEventListener('dragleave', () => {
      el.removeClass('pm-gantt-label-row--drop-before', 'pm-gantt-label-row--drop-after')
    })
    el.addEventListener(
      'drop',
      safeAsync(async (e: DragEvent) => {
        e.preventDefault()
        el.removeClass('pm-gantt-label-row--drop-before', 'pm-gantt-label-row--drop-after')
        const draggedId = e.dataTransfer?.getData('text/plain')
        if (!draggedId || draggedId === task.id) return
        await ctx.plugin.store.reorderTask(ctx.project, draggedId, task.id, dropPosition)
        await ctx.onRefresh()
      })
    )
  }

  // Expand toggle
  if (task.subtasks.length > 0) {
    new CollapseToggle(el, {
      collapsed: task.collapsed,
      onToggle: safeAsync(async () => {
        await ctx.plugin.toggleTaskCollapsed(ctx.project, task.id)
        await ctx.onRefresh()
      })
    })
  } else {
    el.createSpan({ cls: 'pm-gantt-label-spacer' })
  }

  // Color dot
  const statusConfig = getStatusConfig(ctx.plugin.settings.statuses, task.status)
  const dot = el.createSpan({ cls: 'pm-gantt-label-dot' })
  dot.style.background = statusConfig?.color ?? 'var(--text-muted)'

  // Title
  const titleEl = el.createSpan({ text: task.title, cls: 'pm-gantt-label-title' })
  titleEl.addEventListener('click', () => {
    openTaskModal(ctx.plugin, owner, { task, onSave: () => ctx.onRefresh() })
  })

  renderTaskBadges(el, ctx.badgesOf?.(task))

  // Assignee avatars (colored initials), matching the bars and table
  if (task.assignees.length) {
    const avatars = el.createDiv('pm-gantt-label-avatars')
    new AvatarStack(avatars).setRoster(ctx.roster).setNames(task.assignees).setMax(3).setSize('sm')
  }

  // Progress %
  if (task.progress > 0) {
    el.createSpan({ text: `${task.progress}%`, cls: 'pm-gantt-label-progress' })
  }

  if (ctx.readOnly) return

  // "+" button to add subtask (hover-visible)
  const addSubBtn = el.createEl('button', { text: '+', cls: 'pm-gantt-label-add-btn' })
  addSubBtn.title = 'Add subtask'
  addSubBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    openTaskModal(ctx.plugin, owner, { parentId: task.id, onSave: () => ctx.onRefresh() })
  })
}
