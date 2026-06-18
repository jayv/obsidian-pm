import { ButtonComponent, Notice } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task, GanttGranularity, FilterState } from '../../types'
import { type FlatTask, flattenTasks } from '../../store/TaskTreeOps'
import { applyTaskFilterPromote, isFilterActive } from '../../store/TaskFilter'
import { openTaskModal } from '../../ui/ModalFactory'
import type { SubView } from '../SubView'
import type { TimelineCfg } from './TimelineConfig'
import { buildTimelineConfig, dateToX, xToDate, HEADER_HEIGHT, ROW_HEIGHT, LABEL_WIDTH } from './TimelineConfig'
import { makeDragState } from './GanttDragHandler'
import type { DragState } from './GanttDragHandler'
import { makeLinkState, cancelLink } from './GanttLinkHandler'
import type { LinkState } from './GanttLinkHandler'
import {
  renderTimelineHeader,
  renderGridLines,
  renderTodayLine,
  renderTaskBar,
  renderDependencyArrows,
  renderMilestoneLabels
} from './GanttRenderer'
import { svgEl } from '../../utils'
import { Temporal, today } from '../../dates'
import type { RendererContext } from './GanttRenderer'
import { renderTaskLabel } from './TaskLabelRenderer'
import { computeResourceConflicts } from './ResourceConflicts'
import { buildGanttSvg } from './GanttSvgExport'
import type { TaskConflicts } from './ResourceConflicts'

// Shift+wheel zoom: a multiplier on the granularity's base day width.
const ZOOM_MIN = 0.3
const ZOOM_MAX = 5
const ZOOM_STEP = 1.15

export class GanttView implements SubView {
  private granularity: GanttGranularity
  private scrollEl!: HTMLElement
  private svgEl!: SVGSVGElement
  private headerEl!: SVGSVGElement
  private flatTasks: FlatTask[] = []
  private cfg!: TimelineCfg
  private drag: DragState = makeDragState()
  private link: LinkState = makeLinkState()
  private labelWidth: number = LABEL_WIDTH
  private zoom = 1
  private zoomRaf: number | null = null
  private conflictsOnly: boolean
  private conflicts: Map<string, TaskConflicts> | null = null

  getLabelWidth(): number {
    return this.labelWidth
  }
  setLabelWidth(w: number): void {
    this.labelWidth = w
  }
  private cleanupFns: (() => void)[] = []
  private pendingScroll: { top: number; anchorDate: Temporal.PlainDate; offsetX?: number } | null = null

  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private filter: FilterState
  ) {
    this.granularity = plugin.settings.ganttGranularity
    this.conflictsOnly = plugin.settings.ganttConflictsOnly
  }

  destroy(): void {
    if (this.zoomRaf !== null) {
      window.cancelAnimationFrame(this.zoomRaf)
      this.zoomRaf = null
    }
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
  }

  getScrollPosition(): { top: number; anchorDate: Temporal.PlainDate } {
    const top = this.scrollEl?.scrollTop ?? 0
    const anchorDate = this.scrollEl ? xToDate(this.cfg, this.scrollEl.scrollLeft) : today()
    return { top, anchorDate }
  }

  setPendingScroll(pos: { top: number; anchorDate: Temporal.PlainDate }): void {
    this.pendingScroll = pos
  }

  refresh(): void {
    this.pendingScroll = this.getScrollPosition()
    this.render()
  }

  render(): void {
    this.cleanupFns.forEach((fn) => fn())
    this.cleanupFns = []
    cancelLink(this.link)
    this.container.empty()
    this.container.addClass('pm-gantt-view')

    const activeTasks = this.getVisibleTasks()
    this.cfg = buildTimelineConfig(activeTasks, this.granularity, this.zoom)

    // Conflicts are always highlighted. Compute over the full visible set first,
    // then — when the toggle is on — keep only rows that have a conflict.
    let flat = flattenTasks(activeTasks).filter((f) => f.visible || f.depth === 0)
    this.conflicts = computeResourceConflicts(flat, this.plugin.settings.statuses).byTask
    this.conflictsOnly = this.plugin.settings.ganttConflictsOnly
    if (this.conflictsOnly && this.conflicts.size > 0) {
      flat = flat.filter((f) => this.conflicts?.has(f.task.id) || f.task.type === 'milestone')
    }
    // Milestones are reference markers: keep every dated one visible whenever a
    // filter is narrowing the view, re-adding any the filters removed.
    if ((this.conflictsOnly && this.conflicts.size > 0) || isFilterActive(this.filter)) {
      const present = new Set(flat.map((f) => f.task.id))
      const extra = flattenTasks(this.project.tasks).filter(
        (f) => f.task.type === 'milestone' && (f.task.due || f.task.start) && !present.has(f.task.id)
      )
      if (extra.length) flat = [...flat, ...extra]
    }
    this.flatTasks = flat

    this.renderGranularityControls()
    this.renderGantt()
  }

  private renderGranularityControls(): void {
    const bar = this.container.createDiv('pm-gantt-controls')
    const levels: GanttGranularity[] = ['day', 'week', 'month', 'quarter']
    const labels: Record<GanttGranularity, string> = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter' }

    for (const level of levels) {
      const btn = bar.createEl('button', { text: labels[level], cls: 'pm-gantt-zoom-btn' })
      if (level === this.granularity) btn.addClass('pm-gantt-zoom-btn--active')
      btn.addEventListener('click', () => {
        this.granularity = level
        this.zoom = 1
        this.plugin.settings.ganttGranularity = level
        void this.plugin.saveSettings()
        this.render()
      })
    }

    bar.createSpan({ cls: 'pm-gantt-sep' })
    new ButtonComponent(bar).setButtonText('Today').onClick(() => this.scrollToToday())

    new ButtonComponent(bar).setButtonText('Expand all').onClick(() => this.setAllCollapsed(false))
    new ButtonComponent(bar).setButtonText('Collapse all').onClick(() => this.setAllCollapsed(true))
    new ButtonComponent(bar)
      .setButtonText('Export SVG')
      .setTooltip('Export a self-contained interactive SVG of this chart')
      .onClick(() => this.exportSvg())
  }

  private exportSvg(): void {
    try {
      const svg = buildGanttSvg(
        this.project,
        this.plugin.settings.statuses,
        this.plugin.settings.priorities,
        this.granularity
      )
      // Trigger a save dialog so the user picks where to write the file.
      const blob = new Blob([svg], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      const a = activeDocument.createElement('a')
      a.href = url
      a.download = `${this.project.title} Gantt.svg`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      new Notice('Exported. Open the SVG in a browser for zoom / filtering.')
    } catch (e) {
      new Notice('Failed to export the SVG. Check the console.')
      console.error('GanttSvgExport: export failed', e)
    }
  }

  private renderGantt(): void {
    const wrapper = this.container.createDiv('pm-gantt-wrapper')

    // Left panel: task labels
    const leftPanel = wrapper.createDiv('pm-gantt-left')
    leftPanel.style.width = `${this.labelWidth}px`
    leftPanel.style.minWidth = `${this.labelWidth}px`
    const leftHeader = leftPanel.createDiv('pm-gantt-left-header')
    leftHeader.style.height = `${HEADER_HEIGHT}px`
    leftHeader.createSpan({ text: 'Task', cls: 'pm-gantt-left-header-label' })
    const leftBody = leftPanel.createDiv('pm-gantt-left-body')

    // Resize handle
    const resizeHandle = wrapper.createDiv('pm-gantt-resize-handle')
    let resizing = false
    let startX = 0
    let startWidth = 0
    resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      resizing = true
      startX = e.clientX
      startWidth = this.labelWidth
      activeDocument.body.addClass('pm-resize-active')
    })
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing) return
      const newWidth = Math.max(150, Math.min(600, startWidth + (e.clientX - startX)))
      this.labelWidth = newWidth
      leftPanel.style.width = `${newWidth}px`
      leftPanel.style.minWidth = `${newWidth}px`
    }
    const onMouseUp = () => {
      if (!resizing) return
      resizing = false
      activeDocument.body.removeClass('pm-resize-active')
    }
    activeDocument.addEventListener('mousemove', onMouseMove)
    activeDocument.addEventListener('mouseup', onMouseUp)
    this.cleanupFns.push(() => {
      activeDocument.removeEventListener('mousemove', onMouseMove)
      activeDocument.removeEventListener('mouseup', onMouseUp)
    })

    // Right panel: timeline
    const rightPanel = wrapper.createDiv('pm-gantt-right')
    this.scrollEl = rightPanel
    const svgContainer = this.scrollEl.createDiv('pm-gantt-svg-container')
    svgContainer.style.width = `${this.cfg.totalWidth}px`

    const totalRows = this.flatTasks.filter((f) => f.visible || f.depth === 0).length
    const svgHeight = HEADER_HEIGHT + (totalRows + 1) * ROW_HEIGHT // +1 for add-task row

    // Sticky date header: pinned to the top on vertical scroll, scrolls with the
    // timeline horizontally. The body is pulled up under it by HEADER_HEIGHT so
    // the row offsets (which still reserve the header band) stay unchanged.
    this.headerEl = svgEl('svg', {
      width: this.cfg.totalWidth,
      height: HEADER_HEIGHT,
      class: 'pm-gantt-header-svg'
    })
    svgContainer.appendChild(this.headerEl)

    this.svgEl = svgEl('svg', {
      width: this.cfg.totalWidth,
      height: svgHeight,
      class: 'pm-gantt-svg'
    })
    this.svgEl.style.marginTop = `-${HEADER_HEIGHT}px`
    svgContainer.appendChild(this.svgEl)

    // Escape to cancel linking mode; Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z
    // or Ctrl/Cmd+Y to redo the last drag. Only fire when the gantt view's
    // leaf is the active workspace leaf, so we don't hijack undo/redo while
    // the user is editing an unrelated note.
    const isGanttActive = (): boolean => {
      const leafEl = this.container.closest('.workspace-leaf')
      return leafEl?.classList.contains('mod-active') ?? false
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isGanttActive()) return
      if (e.key === 'Escape' && this.link.active) {
        cancelLink(this.link)
      }
      if (this.drag.isDragging) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        void this.plugin.undoLastAction()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        void this.plugin.redoLastAction()
      }
    }
    activeDocument.addEventListener('keydown', onKeyDown)
    this.cleanupFns.push(() => activeDocument.removeEventListener('keydown', onKeyDown))

    // Reflect the Shift key as a class so dependency arrows only highlight and
    // accept a remove-click while Shift is held (guards against accidents).
    const syncShift = (e: KeyboardEvent | FocusEvent) => {
      this.container.toggleClass('pm-gantt--shift', 'shiftKey' in e && e.shiftKey)
    }
    activeDocument.addEventListener('keydown', syncShift)
    activeDocument.addEventListener('keyup', syncShift)
    activeWindow.addEventListener('blur', syncShift)
    this.cleanupFns.push(() => {
      activeDocument.removeEventListener('keydown', syncShift)
      activeDocument.removeEventListener('keyup', syncShift)
      activeWindow.removeEventListener('blur', syncShift)
    })

    const ctx = this.makeRendererContext()
    renderTimelineHeader(ctx)
    renderGridLines(ctx, totalRows)
    renderTodayLine(ctx, svgHeight)
    this.renderTaskRows(leftBody, ctx)
    renderDependencyArrows(ctx)
    renderMilestoneLabels(ctx)

    // Shift+wheel zooms by stretching the day columns horizontally, keeping the
    // date under the cursor fixed. Renders are coalesced to one per frame.
    const onZoomWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return
      e.preventDefault()
      const cursorX = e.clientX - rightPanel.getBoundingClientRect().left
      const anchorDate = xToDate(this.cfg, rightPanel.scrollLeft + cursorX)
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor))
      if (next === this.zoom) return
      this.zoom = next
      this.pendingScroll = { top: rightPanel.scrollTop, anchorDate, offsetX: cursorX }
      if (this.zoomRaf === null) {
        this.zoomRaf = window.requestAnimationFrame(() => {
          this.zoomRaf = null
          this.render()
        })
      }
    }
    rightPanel.addEventListener('wheel', onZoomWheel, { passive: false })
    this.cleanupFns.push(() => rightPanel.removeEventListener('wheel', onZoomWheel))

    // Forward wheel events from left panel to the scroll container
    // (left panel has overflow:hidden, so wheel events are swallowed otherwise)
    const onLeftWheel = (e: WheelEvent) => {
      rightPanel.scrollTop += e.deltaY
      rightPanel.scrollLeft += e.deltaX
      e.preventDefault()
    }
    leftPanel.addEventListener('wheel', onLeftWheel, { passive: false })
    this.cleanupFns.push(() => leftPanel.removeEventListener('wheel', onLeftWheel))

    // Add task button
    const addRow = leftBody.createDiv('pm-gantt-label-row pm-gantt-add-row')
    addRow.style.height = `${ROW_HEIGHT}px`
    const addBtn = addRow.createEl('button', { text: '+ add task', cls: 'pm-gantt-add-task-btn' })
    addBtn.addEventListener('click', () => {
      openTaskModal(this.plugin, this.project, { onSave: () => this.onRefresh() })
    })

    // Spacer compensates for horizontal scrollbar in the right panel.
    // The scrollbar reduces the right panel's viewport height, letting it
    // scroll further than the left body. Without this, rows desync at the bottom.
    const leftSpacer = leftBody.createDiv()
    leftSpacer.addClass('pm-no-shrink')
    const syncSpacer = () => {
      const hScrollbarH = rightPanel.offsetHeight - rightPanel.clientHeight
      leftSpacer.style.height = `${hScrollbarH}px`
    }

    // Sync vertical scroll: right → left
    rightPanel.addEventListener('scroll', () => {
      syncSpacer()
      leftBody.scrollTop = rightPanel.scrollTop
    })

    window.requestAnimationFrame(() => {
      syncSpacer()
      if (this.pendingScroll) {
        this.scrollEl.scrollTop = this.pendingScroll.top
        const offsetX = this.pendingScroll.offsetX ?? 0
        this.scrollEl.scrollLeft = Math.max(0, dateToX(this.cfg, this.pendingScroll.anchorDate) - offsetX)
        this.pendingScroll = null
      } else {
        this.scrollToToday()
      }
    })
  }

  private renderTaskRows(leftBody: HTMLElement, ctx: RendererContext): void {
    const barsGroup = svgEl('g', { class: 'pm-gantt-bars' })
    this.svgEl.appendChild(barsGroup)

    // Iterate the resolved row model so the conflicts-only filter applies and
    // row indexes line up with dependency arrows / grid (both use flatTasks).
    const labelCtx = { plugin: this.plugin, project: this.project, onRefresh: this.onRefresh }
    this.flatTasks.forEach((f, rowIndex) => {
      renderTaskLabel(leftBody, f.task, f.depth, rowIndex, labelCtx)
      renderTaskBar(barsGroup, f.task, rowIndex, f.depth, ctx)
    })
  }

  private makeRendererContext(): RendererContext {
    return {
      svgEl: this.svgEl,
      headerEl: this.headerEl,
      cfg: this.cfg,
      plugin: this.plugin,
      project: this.project,
      flatTasks: this.flatTasks,
      drag: this.drag,
      link: this.link,
      conflicts: this.conflicts,
      onRefresh: this.onRefresh,
      cleanupFns: this.cleanupFns
    }
  }

  private getVisibleTasks(): Task[] {
    return applyTaskFilterPromote(this.project.tasks, this.filter, this.plugin.settings.statuses)
  }

  private scrollToToday(): void {
    if (!this.scrollEl) return
    const x = dateToX(this.cfg, today())
    const center = x - this.scrollEl.clientWidth / 2
    this.scrollEl.scrollLeft = Math.max(0, center)
  }

  private setAllCollapsed(collapsed: boolean): void {
    for (const { task } of flattenTasks(this.project.tasks)) {
      if (task.subtasks.length > 0) task.collapsed = collapsed
    }
    void this.plugin.persistCollapsedState(this.project)
    this.render()
  }
}
