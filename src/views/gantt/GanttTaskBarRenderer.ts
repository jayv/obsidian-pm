import { Notice } from 'obsidian'
import type { Task } from '../../types'
import { openTaskModal } from '../../ui/ModalFactory'
import { svgEl, getStatusConfig, safeAsync, stringToColor } from '../../utils'
import { displayName, initialsFor } from '../../ui/primitives/Avatar'
import { parsePlainDate } from '../../dates'
import {
  ROW_HEIGHT,
  HEADER_HEIGHT,
  BAR_PADDING,
  BAR_BORDER_RADIUS,
  dateToX,
  xToDate,
  getSnapPoints,
  snapX
} from './TimelineConfig'
import { attachDragHandle, attachBarMove, attachSummaryMove } from './GanttDragHandler'
import { attachLinkDrag } from './GanttLinkHandler'
import { subtaskDateSpan } from '../../store/TaskTreeOps'
import type { RendererContext } from './GanttRenderer'

// Milestones use a fixed pastel green so they stand out from status-colored bars
const MILESTONE_COLOR = '#8fd9ad'

// ─── Task bars ─────────────────────────────────────────────────────────────

export function renderTaskBar(g: SVGGElement, task: Task, row: number, _depth: number, ctx: RendererContext): void {
  // A task with dated subtasks renders as a summary bar spanning them; its own
  // start/due are ignored in favor of the rolled-up span across descendants.
  const span = task.type !== 'milestone' && task.subtasks.length > 0 ? subtaskDateSpan(task) : { start: '', due: '' }
  const isSummary = Boolean(span.start || span.due)
  const startStr = isSummary ? span.start || span.due : task.start
  const dueStr = isSummary ? span.due || span.start : task.due

  const startDate = parsePlainDate(startStr)
  const endDate = parsePlainDate(dueStr)
  if (!startDate && !endDate) {
    renderEmptyRowClickTarget(g, task, row, ctx)
    return
  }

  const statusConfig = getStatusConfig(ctx.plugin.settings.statuses, task.status)
  const color = statusConfig?.color ?? getComputedStyle(ctx.svgEl).getPropertyValue('--interactive-accent').trim()
  const rowY = HEADER_HEIGHT + row * ROW_HEIGHT
  const y = rowY + BAR_PADDING
  const height = ROW_HEIGHT - BAR_PADDING * 2

  // Row hover background
  g.appendChild(
    svgEl('rect', {
      x: 0,
      y: rowY,
      width: ctx.cfg.totalWidth,
      height: ROW_HEIGHT,
      class: 'pm-gantt-row-hover'
    })
  )

  // Milestone → render diamond
  if (task.type === 'milestone') {
    renderMilestoneDiamond(g, task, row, ctx)
    return
  }

  // Normal task bar. A task with end date E occupies the day E, so the bar
  // right edge sits at the start of E+1.
  const effectiveStart = startDate ?? endDate
  if (!effectiveStart) return
  const effectiveEnd = (endDate ?? effectiveStart).add({ days: 1 })

  const x = Math.max(0, dateToX(ctx.cfg, effectiveStart))
  const xEnd = Math.min(ctx.cfg.totalWidth, dateToX(ctx.cfg, effectiveEnd))
  const width = Math.max(8, xEnd - x)

  // Group for bar + handles. data-task-id lets drag-to-link hit-test this bar.
  const barGroup = svgEl('g', { class: 'pm-gantt-bar-group', 'data-task-id': task.id })
  g.appendChild(barGroup)

  // Main bar — flat fill, no gradient/shadow/sheen. A summary bar's rect is an
  // invisible full-height hit area (drag/click/tooltip); the visible shape is a
  // thin bar with slanted legs drawn on top below.
  const rect = svgEl('rect', {
    x,
    y,
    width,
    height,
    rx: BAR_BORDER_RADIUS,
    ry: BAR_BORDER_RADIUS,
    fill: color,
    opacity: isSummary ? 0 : 0.4,
    class: isSummary ? 'pm-gantt-bar pm-gantt-bar--summary' : 'pm-gantt-bar'
  })
  barGroup.appendChild(rect)

  // Summary bar: a 4px-thick line with downward slanted legs marking start/end.
  if (isSummary) {
    const TH = 4 // bar thickness
    const LEG = 9 // how far the end legs drop
    const legW = Math.min(6, width / 2)
    const top = y
    const points = [
      `${x},${top}`,
      `${x + width},${top}`,
      `${x + width},${top + LEG}`,
      `${x + width - legW},${top + TH}`,
      `${x + legW},${top + TH}`,
      `${x},${top + LEG}`
    ].join(' ')
    barGroup.appendChild(svgEl('polygon', { points, fill: color, class: 'pm-gantt-summary-shape' }))
  }

  // Completed portion — solid fill over the faint track so progress reads at a
  // glance. Skipped for summary bars, whose span is an aggregate of subtasks.
  if (task.progress > 0 && !isSummary) {
    const pw = (task.progress / 100) * width
    barGroup.appendChild(
      svgEl('rect', {
        x,
        y,
        width: pw,
        height,
        rx: BAR_BORDER_RADIUS,
        ry: BAR_BORDER_RADIUS,
        fill: color,
        opacity: 0.9,
        class: 'pm-gantt-bar-progress'
      })
    )
  }

  // Recurrence indicator
  if (task.recurrence) {
    const icon = svgEl('text', {
      x: x + width + 4,
      y: y + height / 2 + 5,
      class: 'pm-gantt-bar-icon'
    })
    icon.textContent = 'R'
    barGroup.appendChild(icon)
  }

  // Assignee avatars (colored initials) anchored at the right end of the bar.
  // Rendered before the label so the label can reserve room and avoid overlap.
  const avatarZone = renderAssigneeAvatars(barGroup, task, x, width, y, height)

  // Label inside bar
  if (width - avatarZone > 55) {
    const label = svgEl('text', {
      x: x + 8,
      y: y + height / 2 + 5,
      class: 'pm-gantt-bar-label'
    })
    const maxChars = Math.max(4, Math.floor((width - 16 - avatarZone) / 7.5))
    label.textContent = task.title.length > maxChars ? task.title.slice(0, maxChars - 1) + '\u2026' : task.title
    barGroup.appendChild(label)
  }

  // Tooltip
  const ttEl = svgEl('title', {})
  const assigneesStr = task.assignees.length ? `\nAssignees: ${task.assignees.join(', ')}` : ''
  const summaryStr = isSummary ? ' (rolled up from subtasks)' : ''
  ttEl.textContent = `${task.title}\n${statusConfig?.label ?? task.status} \u00b7 ${task.priority}\nStart: ${startStr || '\u2014'}  Due: ${dueStr || '\u2014'}${summaryStr}\nProgress: ${task.progress}%${assigneesStr}`
  rect.appendChild(ttEl)

  // Drag handles \u2014 resize only applies to leaf bars; a summary span is derived.
  if (!isSummary) {
    const HANDLE_W = 8
    for (const side of ['left', 'right'] as const) {
      const hx = side === 'left' ? x : x + width - HANDLE_W
      const handle = svgEl('rect', {
        x: hx,
        y,
        width: HANDLE_W,
        height,
        rx: 3,
        ry: 3,
        class: 'pm-gantt-drag-handle',
        cursor: 'ew-resize'
      })
      const cleanup = attachDragHandle(
        handle,
        side,
        task,
        rect,
        barGroup,
        x,
        width,
        ctx.cfg,
        ctx.drag,
        ctx.plugin,
        ctx.project,
        ctx.onRefresh
      )
      ctx.cleanupFns.push(cleanup)
      barGroup.appendChild(handle)
    }
  }

  // Link dots (dependency connectors) — positioned outside bar edges.
  // Press a dot and drag onto any task bar to create a dependency.
  const DOT_R = 5
  const DOT_GAP = 4
  for (const side of ['left', 'right'] as const) {
    const cx = side === 'left' ? x - DOT_GAP - DOT_R : x + width + DOT_GAP + DOT_R
    const cy = y + height / 2
    const dot = svgEl('circle', {
      cx,
      cy,
      r: DOT_R,
      class: 'pm-gantt-link-dot',
      cursor: 'crosshair'
    })
    ctx.cleanupFns.push(attachLinkDrag(dot, task.id, side, ctx))
    barGroup.appendChild(dot)
  }

  // Move whole bar by dragging. A summary bar slides its whole subtree; a leaf
  // bar moves its own dates (only when both dates exist).
  if (isSummary) {
    const moveCleanup = attachSummaryMove(
      rect,
      barGroup,
      task,
      x,
      ctx.cfg,
      ctx.drag,
      ctx.plugin,
      ctx.project,
      ctx.onRefresh
    )
    ctx.cleanupFns.push(moveCleanup)
    rect.setAttribute('cursor', 'grab')
  } else if (task.start && task.due) {
    const moveCleanup = attachBarMove(
      rect,
      barGroup,
      task,
      x,
      width,
      ctx.cfg,
      ctx.drag,
      ctx.plugin,
      ctx.project,
      ctx.onRefresh
    )
    ctx.cleanupFns.push(moveCleanup)
    rect.setAttribute('cursor', 'grab')
  } else {
    rect.setAttribute('cursor', 'pointer')
  }

  // Click to open modal (suppressed if drag occurred)
  rect.addEventListener('click', () => {
    if (ctx.drag.dragMoved) {
      ctx.drag.dragMoved = false
      return
    }
    openTaskModal(ctx.plugin, ctx.project, { task, onSave: () => ctx.onRefresh() })
  })
}

// ─── Empty row click-to-set-dates ─────────────────────────────────────────

function renderEmptyRowClickTarget(g: SVGGElement, task: Task, row: number, ctx: RendererContext): void {
  const rowY = HEADER_HEIGHT + row * ROW_HEIGHT

  // Invisible rect covering the full row — acts as click target
  const hitArea = svgEl('rect', {
    x: 0,
    y: rowY,
    width: ctx.cfg.totalWidth,
    height: ROW_HEIGHT,
    fill: 'transparent',
    cursor: 'cell',
    class: 'pm-gantt-empty-row-hit'
  })

  // Hover preview bar (hidden until mouseover)
  const previewY = rowY + BAR_PADDING
  const previewH = ROW_HEIGHT - BAR_PADDING * 2
  const previewW = Math.max(ctx.cfg.dayWidth, 8)
  const preview = svgEl('rect', {
    x: 0,
    y: previewY,
    width: previewW,
    height: previewH,
    rx: BAR_BORDER_RADIUS,
    ry: BAR_BORDER_RADIUS,
    class: 'pm-gantt-empty-row-preview',
    'pointer-events': 'none'
  })
  preview.classList.add('pm-hidden')

  g.appendChild(hitArea)
  g.appendChild(preview)

  const snapPoints = getSnapPoints(ctx.cfg)
  const snapThreshold = ctx.cfg.dayWidth * 0.4

  // Track mouse to position the preview bar
  hitArea.addEventListener('mousemove', (e: MouseEvent) => {
    const svgRect = ctx.svgEl.getBoundingClientRect()
    const rawX = e.clientX - svgRect.left
    const snapped = snapX(rawX, snapPoints, snapThreshold)
    preview.setAttribute('x', String(snapped))
    preview.classList.remove('pm-hidden')
  })

  hitArea.addEventListener('mouseleave', () => {
    preview.classList.add('pm-hidden')
  })

  // Click to set start=due=clicked date and save
  hitArea.addEventListener(
    'click',
    safeAsync(async (e: MouseEvent) => {
      const svgRect = ctx.svgEl.getBoundingClientRect()
      const rawX = e.clientX - svgRect.left
      const snapped = snapX(rawX, snapPoints, snapThreshold)
      const iso = xToDate(ctx.cfg, snapped).toString()

      try {
        await ctx.plugin.store.updateTask(ctx.project, task.id, { start: iso, due: iso })
      } catch (err) {
        new Notice('Failed to set task dates. Please try again.')
        console.error('GanttTaskBarRenderer: click-to-set-dates failed', err)
        return
      }
      if (ctx.plugin.settings.autoSchedule) {
        await ctx.plugin.store.scheduleAfterChange(ctx.project, task.id, ctx.plugin.settings.statuses)
      }
      await ctx.onRefresh()
    })
  )

  // Tooltip
  const tt = svgEl('title', {})
  tt.textContent = 'Click to set dates'
  hitArea.appendChild(tt)
}

// ─── Milestone diamond ────────────────────────────────────────────────────

function renderMilestoneDiamond(g: SVGGElement, task: Task, row: number, ctx: RendererContext): void {
  const date = parsePlainDate(task.due) ?? parsePlainDate(task.start)
  if (!date) return

  const cx = dateToX(ctx.cfg, date) + ctx.cfg.dayWidth / 2
  const cy = HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2
  const size = 12

  const pts = `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`
  const diamond = svgEl('polygon', {
    points: pts,
    fill: MILESTONE_COLOR,
    opacity: 0.9,
    class: 'pm-gantt-milestone',
    cursor: 'pointer',
    'data-task-id': task.id
  })
  g.appendChild(diamond)

  const tt = svgEl('title', {})
  tt.textContent = `${task.title} (milestone)\nDate: ${task.due || task.start || '\u2014'}`
  diamond.appendChild(tt)

  diamond.addEventListener('click', () => {
    openTaskModal(ctx.plugin, ctx.project, { task, onSave: () => ctx.onRefresh() })
  })
}

// ─── Milestone labels ─────────────────────────────────────────────────────

export function renderMilestoneLabels(ctx: RendererContext): void {
  const milestones = ctx.flatTasks.filter((f) => f.task.type === 'milestone' && (f.task.due || f.task.start))
  if (!milestones.length) return

  const labelsG = svgEl('g', { class: 'pm-gantt-milestone-labels' })

  for (const { task } of milestones) {
    const date = parsePlainDate(task.due) ?? parsePlainDate(task.start)
    if (!date) continue
    const x = dateToX(ctx.cfg, date) + ctx.cfg.dayWidth / 2

    // Pill geometry — sized from an estimate of the text width (SVG can't
    // measure text before it is laid out, so approximate by character count).
    const cy = 12
    const pillH = 18
    const pillW = task.title.length * 6.2 + 18

    // Dashed connector runs from the bottom of the pill down through the chart,
    // so each milestone reads as one unit (pill + line) like the today marker.
    const totalH = HEADER_HEIGHT + ctx.flatTasks.filter((f) => f.visible || f.depth === 0).length * ROW_HEIGHT
    labelsG.appendChild(
      svgEl('line', {
        x1: x,
        y1: cy + pillH / 2,
        x2: x,
        y2: totalH,
        stroke: MILESTONE_COLOR,
        'stroke-width': 1.5,
        'stroke-dasharray': '4 4',
        opacity: 0.6
      })
    )

    const pill = svgEl('rect', {
      x: x - pillW / 2,
      y: cy - pillH / 2,
      width: pillW,
      height: pillH,
      rx: pillH / 2,
      ry: pillH / 2,
      fill: MILESTONE_COLOR,
      class: 'pm-gantt-milestone-pill'
    })
    labelsG.appendChild(pill)

    const label = svgEl('text', {
      x,
      y: cy,
      'text-anchor': 'middle',
      class: 'pm-gantt-milestone-label'
    })
    label.textContent = task.title
    labelsG.appendChild(label)
  }

  ctx.svgEl.appendChild(labelsG)
}

// ─── Dependency arrows ─────────────────────────────────────────────────────

export function renderDependencyArrows(ctx: RendererContext): void {
  const indexMap = new Map<string, number>()
  ctx.flatTasks.forEach((f, i) => indexMap.set(f.task.id, i))

  const arrowGroup = svgEl('g', { class: 'pm-gantt-arrows' })

  for (const { task } of ctx.flatTasks) {
    if (!task.dependencies?.length) continue
    const toRow = indexMap.get(task.id)
    if (toRow === undefined) continue
    const toY = HEADER_HEIGHT + toRow * ROW_HEIGHT + ROW_HEIGHT / 2
    const taskStart = parsePlainDate(task.start)
    if (!taskStart) continue
    const toX = dateToX(ctx.cfg, taskStart)

    for (const depId of task.dependencies) {
      const fromRow = indexMap.get(depId)
      if (fromRow === undefined) continue
      const depTask = ctx.flatTasks.find((f) => f.task.id === depId)?.task
      const depDue = depTask ? parsePlainDate(depTask.due) : null
      if (!depDue) continue
      const fromX = dateToX(ctx.cfg, depDue.add({ days: 1 }))
      const fromY = HEADER_HEIGHT + fromRow * ROW_HEIGHT + ROW_HEIGHT / 2

      const midX = (fromX + toX) / 2
      const d = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`

      // One group per arrow: a wide invisible hit path makes the thin arrow
      // easy to click, and hovering it highlights the visible arrow in red.
      const arrow = svgEl('g', { class: 'pm-gantt-arrow-group' })
      arrow.appendChild(
        svgEl('path', {
          d,
          class: 'pm-gantt-arrow',
          'marker-end': 'url(#pm-arrowhead)'
        })
      )
      const hit = svgEl('path', { d, class: 'pm-gantt-arrow-hit' })
      const tt = svgEl('title', {})
      tt.textContent = 'Click to remove dependency'
      hit.appendChild(tt)

      const successorId = task.id
      const depsAtRender = task.dependencies
      hit.addEventListener(
        'click',
        safeAsync(async (e: MouseEvent) => {
          e.stopPropagation()
          const next = depsAtRender.filter((dep) => dep !== depId)
          try {
            await ctx.plugin.store.updateTask(ctx.project, successorId, { dependencies: next })
          } catch (err) {
            new Notice('Failed to remove dependency.')
            console.error('GanttTaskBarRenderer: remove dependency failed', err)
            return
          }
          ctx.plugin.pushUndo({
            undo: async () => {
              await ctx.plugin.store.updateTask(ctx.project, successorId, { dependencies: depsAtRender })
              await ctx.onRefresh()
            },
            redo: async () => {
              await ctx.plugin.store.updateTask(ctx.project, successorId, { dependencies: next })
              await ctx.onRefresh()
            }
          })
          new Notice('Dependency removed.')
          await ctx.onRefresh()
        })
      )
      arrow.appendChild(hit)
      arrowGroup.appendChild(arrow)
    }
  }

  // Arrowhead marker
  const defs = getOrCreateDefs(ctx.svgEl)
  const marker = svgEl('marker', {
    id: 'pm-arrowhead',
    markerWidth: 8,
    markerHeight: 8,
    refX: 6,
    refY: 3,
    orient: 'auto'
  })
  marker.appendChild(
    svgEl('path', {
      d: 'M0,0 L0,6 L8,3 z',
      class: 'pm-gantt-arrowhead'
    })
  )
  defs.appendChild(marker)

  ctx.svgEl.appendChild(arrowGroup)
}

// ─── Assignee avatars ──────────────────────────────────────────────────────

const AVATAR_R = 9
const AVATAR_STEP = 13 // horizontal advance per stacked avatar (overlapping)
const AVATAR_EDGE_GAP = 3 // gap between rightmost avatar and bar right edge
const AVATAR_LABEL_GAP = 6 // gap reserved between avatars and the bar label

/**
 * Render up to a few assignee avatars (colored circle + initials) at the right
 * end of the bar. Colors and initials match the table/kanban Avatar primitive.
 * Returns the width (px) consumed at the right edge so the label can avoid it.
 */
function renderAssigneeAvatars(
  barGroup: SVGGElement,
  task: Task,
  x: number,
  width: number,
  y: number,
  height: number
): number {
  if (!task.assignees.length) return 0

  // How many fit without crowding the bar; cap at 3 then show a "+N" marker.
  const maxByWidth = Math.max(0, Math.floor((width - 2 * AVATAR_R - AVATAR_EDGE_GAP) / AVATAR_STEP) + 1)
  if (maxByWidth < 1) return 0
  const maxShown = Math.min(3, maxByWidth, task.assignees.length)

  const names = task.assignees.map(displayName)
  const overflow = names.length - maxShown
  const cy = y + height / 2
  const group = svgEl('g', { class: 'pm-gantt-bar-avatars' })

  // Render right-to-left so earlier assignees stack on top of later ones.
  const slots = maxShown
  for (let i = slots - 1; i >= 0; i--) {
    const cx = x + width - AVATAR_R - AVATAR_EDGE_GAP - i * AVATAR_STEP
    const isOverflowSlot = overflow > 0 && i === slots - 1
    const circle = svgEl('circle', {
      cx,
      cy,
      r: AVATAR_R,
      class: 'pm-gantt-bar-avatar',
      fill: isOverflowSlot ? 'var(--background-modifier-border)' : stringToColor(names[i])
    })
    group.appendChild(circle)

    const text = svgEl('text', {
      x: cx,
      y: cy,
      class: 'pm-gantt-bar-avatar-text'
    })
    text.textContent = isOverflowSlot ? `+${overflow + 1}` : initialsFor(names[i])
    group.appendChild(text)

    const tt = svgEl('title', {})
    tt.textContent = isOverflowSlot ? names.slice(maxShown - 1).join(', ') : names[i]
    circle.appendChild(tt)
  }

  barGroup.appendChild(group)
  return 2 * AVATAR_R + AVATAR_EDGE_GAP + (slots - 1) * AVATAR_STEP + AVATAR_LABEL_GAP
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getOrCreateDefs(el: SVGSVGElement): SVGDefsElement {
  return (
    (el.querySelector('defs') as SVGDefsElement) ??
    (() => {
      const d = svgEl('defs', {})
      el.insertBefore(d, el.firstChild)
      return d
    })()
  )
}
