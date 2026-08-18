import {
  ButtonComponent,
  ExtraButtonComponent,
  ItemView,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
  TFile,
  EventRef
} from 'obsidian'
import type PMPlugin from '../main'
import { Project, Task, ViewMode, FilterState, SavedView, makeDefaultFilter, makeId } from '../types'
import { getStatusConfig, truncateTitle, safeAsync } from '../utils'
import type { SubView } from './SubView'
import { TableView } from './table/TableView'
import type { TableViewState } from './table/TableView'
import { GanttView } from './gantt/GanttView'
import { KanbanView } from './KanbanView'
import { openProjectModal, openTaskModal } from '../ui/ModalFactory'
import { ViewSwitcher } from '../ui/primitives/ViewSwitcher'
import { ProjectHeader, type HeaderUiState } from '../ui/composites/ProjectHeader'
import { flattenTasks, type FlatTask } from '../store/TaskTreeOps'
import { cloneFilter, filterEquals, isFilterActive, matchesFilter } from '../store/TaskFilter'
import { computeResourceConflicts } from './gantt/ResourceConflicts'
import { projectRoster } from '../ui/roster'
import { displayName } from '../ui/primitives/Avatar'

export const PM_PROJECT_VIEW_TYPE = 'pm-project'

/** True when the event target is a text field, so global key shortcuts should stand down. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

interface ProjectViewState {
  filePath: string
  [key: string]: unknown
}

export class ProjectView extends ItemView {
  plugin: PMPlugin
  project: Project | null = null
  filePath = ''
  currentView: ViewMode
  filter: FilterState = makeDefaultFilter()
  activeSavedViewId: string | null = null
  /** Header UI state that must persist across view switches (header is rebuilt each switch). */
  private headerUi: HeaderUiState = { filterOpen: false, assigneeZoneOpen: false }
  private subview: SubView | null = null
  private savedTableViewState: TableViewState | null = null
  private toolbarEl!: HTMLElement
  private headerEl!: HTMLElement
  private bodyEl!: HTMLElement
  private header: ProjectHeader | null = null
  private titleEl2!: HTMLElement
  /** "visible | total" task counter in the toolbar (left of the view switcher). */
  private countEl: HTMLElement | null = null
  /** Maximized ("zen") mode: chrome hidden so the chart/board gets the whole leaf. */
  private maximized = false
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null
  private fileModifyRef: EventRef | null = null
  private reloadDebounceTimer: number | null = null

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.currentView = plugin.settings.defaultView
    this.navigation = false
  }

  getViewType(): string {
    return PM_PROJECT_VIEW_TYPE
  }
  getDisplayText(): string {
    return truncateTitle(this.project?.title ?? 'Project', 10)
  }
  getIcon(): string {
    return 'chart-gantt'
  }

  async setState(state: ProjectViewState, result: unknown): Promise<void> {
    if (state.filePath && state.filePath !== this.filePath) {
      this.filePath = state.filePath
      await this.loadProject()
    }
    await super.setState(state, result as import('obsidian').ViewStateResult)
  }

  getState(): ProjectViewState {
    return { filePath: this.filePath }
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass('pm-view')
    const root = this.contentEl
    root.empty()
    root.addClass('pm-root')
    this.toolbarEl = root.createDiv('pm-toolbar')
    this.headerEl = root.createDiv('pm-project-header-mount')
    this.bodyEl = root.createDiv('pm-content')

    if (this.filePath) await this.loadProject()
    this.subview?.focus?.() // keyboard-ready on open (Insert / arrow-nav without tabbing in)

    this.keydownHandler = (e: KeyboardEvent) => {
      // Let the sub-view act first — the table turns Insert into a subtask of the
      // highlighted row (and consumes it via preventDefault).
      this.subview?.handleKeyDown?.(e)
      // Insert = add a task, from any sub-view. Ignored while typing in a field, and
      // skipped when the sub-view already handled it.
      if (e.key === 'Insert' && !e.defaultPrevented && !isEditableTarget(e.target)) {
        e.preventDefault()
        this.openNewTaskModal()
      }
    }
    this.containerEl.addEventListener('keydown', this.keydownHandler)
    if (!this.containerEl.hasAttribute('tabindex')) {
      this.containerEl.setAttribute('tabindex', '-1')
    }

    const reloadIfRelevant = (filePath: string) => {
      if (!this.project || !this.filePath) return false
      const taskFolder = this.filePath.replace(/\.md$/, '_tasks')
      return filePath.startsWith(taskFolder) || filePath === this.filePath
    }
    this.fileModifyRef = this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile) || !reloadIfRelevant(file.path)) return
      if (this.plugin.store.consumeSelfWrite(file.path)) return
      if (this.reloadDebounceTimer !== null) window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = window.setTimeout(
        safeAsync(async () => {
          this.reloadDebounceTimer = null
          await this.loadProject()
        }),
        300
      )
    })
    this.registerEvent(this.fileModifyRef)
    this.registerEvent(
      this.app.vault.on(
        'delete',
        safeAsync(async (file) => {
          if (!reloadIfRelevant(file.path)) return
          if (this.plugin.store.consumeSelfWrite(file.path)) return
          await this.loadProject()
        })
      )
    )
  }

  onClose(): Promise<void> {
    if (this.reloadDebounceTimer !== null) {
      window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    if (this.keydownHandler) {
      this.containerEl.removeEventListener('keydown', this.keydownHandler)
      this.keydownHandler = null
    }
    this.fileModifyRef = null
    // Never leave Obsidian's chrome hidden behind a view that no longer exists.
    this.containerEl.ownerDocument.body.removeClass('pm-maximized')
    this.subview?.destroy?.()
    this.subview = null
    return Promise.resolve()
  }

  private async loadProject(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.filePath)
    if (!(file instanceof TFile)) {
      this.renderMissingProject()
      return
    }
    this.project = await this.plugin.store.loadProject(file)
    if (!this.project) {
      this.renderMissingProject()
      return
    }
    this.plugin.applyCollapsedState(this.project)
    this.loadFilterFromSettings()
    ;(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.()
    this.renderProjectToolbar()
    this.renderProjectHeader()
    this.renderCurrentView()
  }

  private loadFilterFromSettings(): void {
    const saved = this.plugin.settings.projectFilters[this.filePath]
    if (saved) {
      // Clone out of settings: the live filter is mutated in place by the UI (the
      // dropdowns/avatars splice/push its arrays), which would otherwise corrupt the
      // stored settings object (and any saved view sharing its arrays).
      this.filter = cloneFilter(saved.filter)
      this.activeSavedViewId = saved.activeSavedViewId
    } else {
      this.filter = makeDefaultFilter()
      this.activeSavedViewId = null
    }
    // Open the filter bar on load when a filter is already applied, so it's never hidden
    // (a silently-active filter changes what the views show). Thereafter the user controls
    // it, and the state persists across view switches via headerUi.
    this.headerUi.filterOpen = isFilterActive(this.filter) || this.filter.showArchived
  }

  private async persistFilter(): Promise<void> {
    if (!this.filePath) return
    this.plugin.settings.projectFilters[this.filePath] = {
      // Store a copy, never the live reference, so later in-place edits don't reach
      // back into settings.
      filter: cloneFilter(this.filter),
      activeSavedViewId: this.activeSavedViewId
    }
    await this.plugin.saveSettings()
  }

  /** Open the new-task modal for this project (toolbar button + the Insert shortcut). */
  private openNewTaskModal(): void {
    if (!this.project) return
    openTaskModal(this.plugin, this.project, {
      onSave: async () => {
        await this.refreshProject()
      }
    })
  }

  private renderMissingProject(): void {
    this.toolbarEl.empty()
    this.headerEl.empty()
    this.header = null
    this.bodyEl.empty()
    const msg = this.bodyEl.createDiv('pm-empty-state')
    msg.createEl('h3', { text: 'Project not found' })
    msg.createEl('p', { text: `No project at ${this.filePath}. It may have been deleted or renamed.` })
  }

  private renderProjectHeader(): void {
    if (!this.project) return
    this.headerEl.empty()
    this.header = new ProjectHeader(this.headerEl, {
      project: this.project,
      statuses: this.plugin.settings.statuses,
      priorities: this.plugin.settings.priorities,
      roster: projectRoster(this.project, this.plugin.settings),
      filter: this.filter,
      activeSavedViewId: this.activeSavedViewId,
      uiState: this.headerUi,
      onFilterChange: () => this.handleFilterMutation(),
      onClearFilter: () => this.handleClearFilter(),
      onSavedViewSelect: (id) => this.handleSavedViewSelect(id),
      onSavedViewSave: (name) => this.handleSavedViewSave(name),
      onSavedViewUpdate: (id) => this.handleSavedViewUpdate(id),
      onSavedViewDelete: (id) => this.handleSavedViewDelete(id),
      viewMode: this.currentView,
      onToggleConflicts: () => this.handleToggleConflicts(),
      ganttControlsVisible: this.plugin.settings.ganttControlsVisible,
      onToggleGanttControls: () => this.handleToggleGanttControls()
    })
    this.updateConflictIndicator()
  }

  /** Show/hide the Gantt's controls bar. The subview re-renders to add/remove it. */
  private handleToggleGanttControls(): void {
    this.plugin.settings.ganttControlsVisible = !this.plugin.settings.ganttControlsVisible
    void this.plugin.saveSettings()
    this.subview?.render()
    this.updateTaskCounts()
  }

  private handleToggleConflicts(): void {
    this.plugin.settings.ganttConflictsOnly = !this.plugin.settings.ganttConflictsOnly
    void this.plugin.saveSettings()
    this.subview?.refresh?.()
    this.updateTaskCounts()
    this.updateConflictIndicator()
  }

  /** Refresh the header's conflict indicator (project-wide count + filter state). */
  private updateConflictIndicator(): void {
    if (!this.header || !this.project) return
    const count =
      this.currentView === 'gantt'
        ? computeResourceConflicts(flattenTasks(this.project.tasks), this.plugin.settings.statuses).count
        : 0
    this.header.setConflicts(count, this.plugin.settings.ganttConflictsOnly)
  }

  private handleFilterMutation(): void {
    // A custom view stays "toggled" only while the live filter still equals its preset;
    // any change that breaks the match un-toggles it (and changing back re-toggles it).
    const matchId = this.matchingSavedViewId()
    if (matchId !== this.activeSavedViewId) {
      this.activeSavedViewId = matchId
      this.header?.setActiveSavedViewId(matchId)
    }
    this.header?.notifyMutation()
    void this.persistFilter()
    this.refreshSubview()
  }

  /** The saved view whose preset the live filter currently matches, or null. */
  private matchingSavedViewId(): string | null {
    return this.project?.savedViews.find((v) => filterEquals(v.filter, this.filter))?.id ?? null
  }

  private handleClearFilter(): void {
    Object.assign(this.filter, makeDefaultFilter())
    this.activeSavedViewId = null
    void this.persistFilter()
    this.header?.refresh(this.activeSavedViewId)
    this.refreshSubview()
  }

  private handleSavedViewSelect(id: string | null): void {
    if (!this.project) return
    if (id === null) {
      Object.assign(this.filter, makeDefaultFilter())
      this.activeSavedViewId = null
    } else {
      const sv = this.project.savedViews.find((v) => v.id === id)
      if (!sv) return
      // Clean replace (not merge): a cloned preset fully overwrites every field, so no
      // stale filters linger and the live filter never shares array refs with the view.
      Object.assign(this.filter, cloneFilter(sv.filter))
      this.activeSavedViewId = sv.id
      if (sv.viewMode && sv.viewMode !== this.currentView) {
        this.currentView = sv.viewMode
        this.renderProjectToolbar()
      }
      if (this.subview instanceof TableView) {
        this.savedTableViewState = { sortKey: sv.sortKey as TableViewState['sortKey'], sortDir: sv.sortDir }
      }
    }
    void this.persistFilter()
    this.header?.refresh(this.activeSavedViewId)
    this.renderCurrentView()
  }

  private async handleSavedViewSave(name: string): Promise<void> {
    if (!this.project) return
    const sortMeta =
      this.subview instanceof TableView ? this.subview.getViewState() : { sortKey: 'status', sortDir: 'asc' as const }
    const sv: SavedView = {
      id: makeId(),
      name,
      filter: cloneFilter(this.filter),
      sortKey: sortMeta.sortKey,
      sortDir: sortMeta.sortDir,
      viewMode: this.currentView
    }
    this.project.savedViews.push(sv)
    this.activeSavedViewId = sv.id
    await this.plugin.store.saveProject(this.project)
    void this.persistFilter()
    this.header?.refresh(this.activeSavedViewId)
  }

  private async handleSavedViewUpdate(id: string): Promise<void> {
    if (!this.project) return
    const sv = this.project.savedViews.find((v) => v.id === id)
    if (!sv) return
    sv.filter = cloneFilter(this.filter)
    sv.viewMode = this.currentView
    if (this.subview instanceof TableView) {
      const ts = this.subview.getViewState()
      sv.sortKey = ts.sortKey
      sv.sortDir = ts.sortDir
    }
    await this.plugin.store.saveProject(this.project)
    this.header?.refresh(this.activeSavedViewId)
  }

  private async handleSavedViewDelete(id: string): Promise<void> {
    if (!this.project) return
    this.project.savedViews = this.project.savedViews.filter((v) => v.id !== id)
    if (this.activeSavedViewId === id) this.activeSavedViewId = null
    await this.plugin.store.saveProject(this.project)
    void this.persistFilter()
    this.header?.refresh(this.activeSavedViewId)
  }

  private refreshSubview(): void {
    this.subview?.render()
    this.updateTaskCounts()
  }

  /**
   * Refresh the toolbar's "visible | total" counter. Called after every path that
   * re-renders the active subview, so `visible` is read from the set the view just
   * rendered (via SubView.visibleCount) and can never drift from the screen. `total` is
   * every task in the project (incl. subtasks), minus archived unless the filter shows them.
   */
  private updateTaskCounts(): void {
    if (!this.countEl || !this.project) return
    const visible = this.subview?.visibleCount?.() ?? 0
    const includeArchived = this.filter.showArchived
    const total = flattenTasks(this.project.tasks).filter((f) => includeArchived || !f.task.archived).length
    this.countEl.setText(`${visible} | ${total}`)
    this.countEl.setAttr('aria-label', `${visible} visible of ${total} tasks`)
  }

  private renderProjectToolbar(): void {
    if (!this.project) return
    this.toolbarEl.empty()

    const left = this.toolbarEl.createDiv('pm-toolbar-left')
    const iconEl = left.createSpan({
      text: this.project.icon,
      cls: 'pm-toolbar-icon',
      attr: { 'aria-label': 'Edit project', role: 'button', tabindex: '0' }
    })
    iconEl.addEventListener('click', () => {
      openProjectModal(this.plugin, {
        project: this.project,
        onSave: (updated) => {
          this.project = updated
          this.renderProjectToolbar()
        }
      })
    })

    this.titleEl2 = left.createEl('h2', { text: this.project.title, cls: 'pm-toolbar-title' })
    this.titleEl2.contentEditable = 'true'
    this.titleEl2.addEventListener(
      'blur',
      safeAsync(async () => {
        if (!this.project) return
        this.project.title = this.titleEl2.textContent?.trim() ?? this.project.title
        await this.plugin.store.saveProject(this.project)
      })
    )

    // Description beside the title (smaller, muted), rendered as Markdown so internal
    // [[links]] and external links work. Edited via the project modal.
    if (this.project.description.trim()) {
      const descEl = left.createDiv('pm-toolbar-desc')
      void MarkdownRenderer.render(this.app, this.project.description, descEl, this.filePath, this)
      // MarkdownRenderer emits internal links but doesn't wire their navigation outside
      // Obsidian's own markdown views, so handle the click ourselves (external links work
      // on their own). Cmd/Ctrl/middle-click opens in a new leaf.
      descEl.addEventListener('click', (evt) => {
        const link = (evt.target as HTMLElement).closest<HTMLElement>('a.internal-link')
        if (!link) return
        evt.preventDefault()
        const href = link.getAttribute('data-href') ?? link.getAttribute('href')
        if (href) void this.app.workspace.openLinkText(href, this.filePath, evt.ctrlKey || evt.metaKey)
      })
    }

    // Task counter, immediately left of the view switcher: "visible | total".
    this.countEl = this.toolbarEl.createSpan({
      cls: 'pm-toolbar-count',
      attr: { 'aria-label': 'Visible tasks | total tasks' }
    })
    this.updateTaskCounts()

    new ViewSwitcher<ViewMode>(this.toolbarEl, {
      options: [
        { id: 'table', icon: 'table', label: 'Table' },
        { id: 'gantt', icon: 'git-fork', label: 'Gantt' },
        { id: 'kanban', icon: 'layout-dashboard', label: 'Board' }
      ],
      active: this.currentView,
      onChange: (mode) => this.setView(mode)
    })

    const right = this.toolbarEl.createDiv('pm-toolbar-right')
    new ButtonComponent(right)
      .setButtonText('+ add task')
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Insert" names the keyboard key
      .setTooltip('Add task (Insert)')
      .setCta()
      .onClick(() => this.openNewTaskModal())

    for (const c of this.plugin.connectors.activeFor(this.project)) {
      if (!c.toolbarActions) continue
      for (const action of c.toolbarActions(this.project)) {
        new ButtonComponent(right).setButtonText(action.label).onClick(action.onClick)
      }
    }

    // Sync button (rightmost) — only for connectors enabled on this project.
    for (const c of this.plugin.connectors.activeFor(this.project)) {
      if (!c.syncNow || !c.isEnabled(this.project)) continue
      new ExtraButtonComponent(right)
        .setIcon('refresh-cw')
        .setTooltip(`Sync with ${c.name}`)
        .onClick(() => {
          if (this.project) void c.syncNow?.(this.project)
        })
    }

    new ExtraButtonComponent(right)
      .setIcon('clipboard-list')
      .setTooltip('Copy visible tasks as Markdown')
      .onClick(safeAsync(() => this.copyVisibleTasksMarkdown()))

    // Always present (so the toolbar doesn't reflow between views), but only active on
    // the Gantt — it exports the Gantt chart.
    const isGantt = this.currentView === 'gantt'
    const svgBtn = new ExtraButtonComponent(right)
      .setIcon('external-link')
      .setTooltip(isGantt ? 'Export as SVG' : 'Export as SVG (Gantt view only)')
      .setDisabled(!isGantt)
      .onClick(() => {
        if (this.subview instanceof GanttView) this.subview.exportSvg()
      })
    svgBtn.extraSettingsEl.toggleClass('pm-toolbar-icon--disabled', !isGantt)

    new ExtraButtonComponent(right)
      .setIcon('settings')
      .setTooltip('Project settings')
      .onClick(() => {
        openProjectModal(this.plugin, {
          project: this.project,
          onSave: (updated) => {
            this.project = updated
            this.renderProjectToolbar()
            this.renderCurrentView()
          }
        })
      })
  }

  /**
   * Copy the currently-visible leaf tasks (passing the active filter, parents excluded)
   * to the clipboard as a Markdown bullet list — handy for pasting a status update into
   * Slack. Tasks are grouped by assignee then due date; milestones are listed last.
   */
  private async copyVisibleTasksMarkdown(): Promise<void> {
    if (!this.project) return
    const project = this.project
    const statuses = this.plugin.settings.statuses
    const flat = flattenTasks(project.tasks)
    const byId = new Map(flat.map((f) => [f.task.id, f]))
    const visible = flat.filter((f) => f.task.subtasks.length === 0 && matchesFilter(f.task, this.filter, statuses))
    if (!visible.length) {
      new Notice('No visible tasks to copy.')
      return
    }

    // Empty due dates sort after dated ones.
    const byDue = (a: Task, b: Task): number =>
      a.due === b.due ? 0 : !a.due ? 1 : !b.due ? -1 : a.due.localeCompare(b.due)
    const namesOf = (t: Task): string[] => t.assignees.map(displayName)
    const whoOf = (t: Task): string => (t.assignees.length ? namesOf(t).join(', ') : 'Unassigned')
    const fmtDue = (t: Task): string => (t.due ? ` _(${t.due})_` : '')
    // Status symbol prefix so each line reads "<symbol> <task> <due>". Omitted (no leading
    // space) when the status has no icon configured.
    const fmtSym = (t: Task): string => {
      const icon = getStatusConfig(statuses, t.status)?.icon
      return icon ? `${icon} ` : ''
    }
    // Linked issue keys sit between the title and the due date, e.g. "Child [ENG-123] _(2026-08-20)_",
    // as a Markdown link to the issue when the connector supplies a URL. Tasks with no link
    // contribute nothing, not an empty pair of brackets.
    const fmtKeys = (t: Task): string =>
      this.plugin.connectors
        .taskBadges(project, t)
        .map((b) => (b.href ? ` [${b.label}](${b.href})` : ` [${b.label}]`))
        .join('')
    // Prefix a subtask with its ancestor chain: "Parent > Child > …".
    const titlePath = (f: FlatTask): string => {
      const parts = [f.task.title]
      for (let pid = f.parentId; pid; ) {
        const parent = byId.get(pid)
        if (!parent) break
        parts.unshift(parent.task.title)
        pid = parent.parentId
      }
      return parts.join(' > ')
    }

    // Group tasks by assignee into a nested list: assignee header, then its tasks.
    const groups = new Map<string, FlatTask[]>()
    for (const f of visible) {
      if (f.task.type === 'milestone') continue
      const key = whoOf(f.task)
      const arr = groups.get(key)
      if (arr) arr.push(f)
      else groups.set(key, [f])
    }
    // Named assignees alphabetically; "Unassigned" grouped at the end.
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      if ((a === 'Unassigned') !== (b === 'Unassigned')) return a === 'Unassigned' ? 1 : -1
      return a.localeCompare(b)
    })

    // Assignee group header: @-mention each person so a pasted update pings them.
    // "Unassigned" is nobody, so it stays styled rather than mentioned.
    const headerOf = (key: string, items: FlatTask[]): string => {
      const names = items.length ? namesOf(items[0].task) : []
      return names.length ? `- ${names.map((n) => `@${n}`).join(', ')}` : `- *${key}*`
    }
    // "<symbol> <title path> [<issue key>] <due>" — one definition for both groupings.
    const lineOf = (f: FlatTask): string => `    - ${fmtSym(f.task)}${titlePath(f)}${fmtKeys(f.task)}${fmtDue(f.task)}`

    const lines: string[] = []
    // Milestones first, nested under their own group header like the assignees.
    const milestones = visible.filter((f) => f.task.type === 'milestone').sort((a, b) => byDue(a.task, b.task))
    if (milestones.length) {
      lines.push('- *Milestones*')
      for (const f of milestones) lines.push(lineOf(f))
    }
    for (const key of orderedKeys) {
      const items = (groups.get(key) ?? []).sort((a, b) => byDue(a.task, b.task))
      lines.push(headerOf(key, items))
      for (const f of items) lines.push(lineOf(f))
    }
    await navigator.clipboard.writeText(lines.join('\n'))
    new Notice(`Copied ${lines.length} item${lines.length === 1 ? '' : 's'} as Markdown.`)
  }

  /** Focus the task search box. Used by the search-focus hotkey. */
  focusSearch(): void {
    this.header?.focusSearch()
  }

  /**
   * Toggle maximized mode (Alt+Z): hide the toolbar, header and filter/search rows so the active
   * view fills the leaf. The sub-view is re-rendered afterwards because the Gantt and the
   * table size themselves from the container, which just changed height.
   */
  toggleMaximize(force?: boolean): void {
    const next = force ?? !this.maximized
    if (next === this.maximized) return
    this.maximized = next
    this.contentEl.toggleClass('pm-root--maximized', this.maximized)
    // Obsidian's own chrome (this pane's title bar and its tab bar) is outside our view,
    // so it's driven by a body class. Scoped to the document that owns this leaf, which
    // may be a pop-out window.
    this.containerEl.ownerDocument.body.toggleClass('pm-maximized', this.maximized)
    this.renderCurrentView()
    this.subview?.focus?.() // keep the toggle working without clicking back in
    // Every control just disappeared, so say how to get back.
    if (this.maximized) new Notice('Maximized — Alt+Z to restore.')
  }

  isMaximized(): boolean {
    return this.maximized
  }

  /** Switch the active sub-view (table/gantt/kanban). Used by the view hotkeys. */
  setView(mode: ViewMode): void {
    if (!this.project || this.currentView === mode) return
    this.currentView = mode
    this.renderProjectToolbar()
    this.renderProjectHeader()
    this.renderCurrentView()
    // Put keyboard focus in the freshly-shown view so arrow-nav / Insert work right away
    // (otherwise focus sits on the toolbar and takes many tabs to reach the list).
    this.subview?.focus?.()
  }

  private renderCurrentView(): void {
    if (!this.project) return

    let savedGanttScroll: ReturnType<GanttView['getScrollPosition']> | null = null
    let savedGanttLabelWidth: number | null = null
    if (this.currentView === 'gantt' && this.subview instanceof GanttView) {
      savedGanttScroll = this.subview.getScrollPosition()
      savedGanttLabelWidth = this.subview.getLabelWidth()
    }

    let savedTableScrollTop: number | null = null
    if (this.subview instanceof TableView) {
      this.savedTableViewState = this.subview.getViewState()
      if (this.currentView === 'table') {
        savedTableScrollTop = this.subview.getScrollTop()
      }
    } else if (this.currentView !== 'table') {
      this.savedTableViewState = null
    }

    this.subview?.destroy?.()
    this.bodyEl.empty()
    this.subview = null

    switch (this.currentView) {
      case 'table': {
        const table = new TableView(
          this.bodyEl,
          this.project,
          this.plugin,
          () => this.refreshProject(),
          this.filter,
          this.savedTableViewState ?? undefined
        )
        if (savedTableScrollTop !== null) table.setPendingScrollTop(savedTableScrollTop)
        this.subview = table
        break
      }
      case 'gantt': {
        const gantt = new GanttView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), this.filter)
        if (savedGanttScroll) gantt.setPendingScroll(savedGanttScroll)
        if (savedGanttLabelWidth !== null) gantt.setLabelWidth(savedGanttLabelWidth)
        this.subview = gantt
        break
      }
      case 'kanban':
        this.subview = new KanbanView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), this.filter)
        break
    }
    this.bodyEl.toggleClass('pm-content--kanban', this.currentView === 'kanban')
    this.subview?.render()
    this.updateTaskCounts()
  }

  /**
   * Re-render after a plugin-initiated mutation. Store mutators update
   * project.tasks in place before they await the save, so memory is already
   * current and no disk reload is needed. External edits come in through the
   * modify/delete listeners in onOpen. Prefers the subview's in-place refresh
   * over a full destroy-and-rebuild.
   */
  async refreshProject(): Promise<void> {
    if (!this.project) return
    if (this.reloadDebounceTimer !== null) {
      window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }

    // The store's cached project is canonical; a background sync (or another open
    // leaf) can replace it out-of-band — e.g. when a sync-time file write evicts the
    // cache and the next load re-parses a fresh object. Re-read it: a cache hit returns
    // the same reference (the cheap in-place refresh below), but if the reference
    // changed we've been holding a stale copy and must rebuild against the fresh one.
    const file = this.filePath ? this.app.vault.getAbstractFileByPath(this.filePath) : null
    if (file instanceof TFile) {
      const canonical = await this.plugin.store.loadProject(file)
      if (canonical && canonical !== this.project) {
        this.project = canonical
        this.plugin.applyCollapsedState(this.project)
        this.renderProjectToolbar()
        this.renderProjectHeader()
        this.renderCurrentView() // subview holds the old reference — rebuild it
        this.updateConflictIndicator()
        return
      }
    }

    if (this.subview?.refresh) {
      this.subview.refresh()
    } else if (this.subview) {
      this.subview.render()
    } else {
      this.renderCurrentView()
    }
    // A task may have been added/deleted or moved in/out of the filter.
    this.updateTaskCounts()
    // An edit may have created or resolved conflicts.
    this.updateConflictIndicator()
  }
}
