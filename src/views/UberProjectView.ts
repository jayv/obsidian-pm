import { ItemView, WorkspaceLeaf, Notice } from 'obsidian'
import type PMPlugin from '../main'
import {
  UBER_FILTER_KEY,
  makeDefaultFilter,
  makeId,
  type FilterState,
  type Project,
  type SavedView,
  type Task
} from '../types'
import { buildUberProject, type UberProject } from '../store/UberProject'
import { applyTaskFilterPromote } from '../store/TaskFilter'
import { countTasks, findTask, flattenTasks } from '../store/TaskTreeOps'
import { projectRoster } from '../ui/roster'
import { FilterRow } from '../ui/composites/ProjectHeader/FilterRow'
import { PrimaryRow } from '../ui/composites/ProjectHeader/PrimaryRow'
import { computeResourceConflicts } from './gantt/ResourceConflicts'
import type { HeaderUiState } from '../ui/composites/ProjectHeader/ProjectHeader'
import { GanttView } from './gantt/GanttView'

export const PM_UBER_VIEW_TYPE = 'pm-uber-project'

/**
 * One gantt across every project — for planning at the level above a single project.
 *
 * The chart renders a virtual project (see buildUberProject) with each real project as a
 * heading row. It is read-only for now: bars can't be dragged and rows can't be reordered,
 * because a write here has to be redirected to the project that actually owns the task.
 * Opening a task from the tree column already does that, so edits made there land in the
 * right file.
 */
export class UberProjectView extends ItemView {
  private plugin: PMPlugin
  private bodyEl!: HTMLElement
  private sources: Project[] = []
  private uber: UberProject | null = null
  private gantt: GanttView | null = null
  private filter: FilterState = makeDefaultFilter()
  private headerUi: HeaderUiState = { filterOpen: true, assigneeZoneOpen: true }
  private headerEl!: HTMLElement
  private filterEl!: HTMLElement
  private savedViews: SavedView[] = []
  private activeSavedViewId: string | null = null
  private primary: PrimaryRow | null = null
  private loading = false
  private maximized = false
  private reloadTimer: number | null = null
  /**
   * Collapsed heading rows, by id. Kept here rather than in settings.collapsedTasks: that
   * map is keyed by project file, and these rows belong to no file. Ids are derived from
   * project ids, so they survive a rebuild.
   */
  private collapsedHeadings = new Set<string>()

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.navigation = false
  }

  getViewType(): string {
    return PM_UBER_VIEW_TYPE
  }
  getDisplayText(): string {
    return 'All projects'
  }
  getIcon(): string {
    return 'chart-gantt'
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass('pm-view')
    const root = this.contentEl
    root.empty()
    root.addClass('pm-root')
    this.headerEl = root.createDiv('pm-project-header')
    this.filterEl = root.createDiv('pm-uber-filter')
    this.bodyEl = root.createDiv('pm-content')
    this.filter = this.loadFilter()
    this.savedViews = this.plugin.settings.projectFilters?.[UBER_FILTER_KEY]?.savedViews ?? []
    await this.reload()
    this.registerVaultListeners()
  }

  /** Edits land in project files, so watch them rather than making the user press Reload. */
  private registerVaultListeners(): void {
    const isRelevant = (path: string) => {
      const folder = this.plugin.settings.projectsFolder
      return path === folder || path.startsWith(`${folder}/`)
    }
    const scheduleReload = (path: string) => {
      if (!isRelevant(path)) return
      if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer)
      this.reloadTimer = window.setTimeout(() => {
        this.reloadTimer = null
        void this.reload()
      }, 300)
    }
    this.registerEvent(this.app.vault.on('create', (file) => scheduleReload(file.path)))
    this.registerEvent(this.app.vault.on('modify', (file) => scheduleReload(file.path)))
    this.registerEvent(this.app.vault.on('delete', (file) => scheduleReload(file.path)))
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        scheduleReload(file.path)
        scheduleReload(oldPath)
      })
    )
  }

  onClose(): Promise<void> {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer)
    this.gantt?.destroy?.()
    // The body class outlives the view, so a maximized view closing would leave Obsidian
    // without its tab bar.
    this.containerEl.ownerDocument.body.removeClass('pm-maximized')
    return Promise.resolve()
  }

  /**
   * Alt+Z, same as a project view: hide this plugin's chrome and Obsidian's own pane
   * header and tab bar. The assignee avatars stay — picking who you're looking at is the
   * point of the view, not chrome. Shares the classes with ProjectView, so the rules and
   * the "what survives" decision live in one place.
   */
  toggleMaximize(force?: boolean): void {
    const next = force ?? !this.maximized
    if (next === this.maximized) return
    this.maximized = next
    this.contentEl.toggleClass('pm-root--maximized', this.maximized)
    this.containerEl.ownerDocument.body.toggleClass('pm-maximized', this.maximized)
    if (this.maximized) new Notice('Maximized — Alt+Z to restore.')
  }

  /**
   * Everything across every project is almost never what you want to look at, so the view
   * opens narrowed to the current week and remembers whatever you narrow it to after that.
   */
  private loadFilter(): FilterState {
    const saved = this.plugin.settings.projectFilters?.[UBER_FILTER_KEY]?.filter
    return saved ? { ...makeDefaultFilter(), ...saved } : { ...makeDefaultFilter(), activeWeeks: [0] }
  }

  private saveFilter(): void {
    this.plugin.settings.projectFilters = this.plugin.settings.projectFilters ?? {}
    this.plugin.settings.projectFilters[UBER_FILTER_KEY] = {
      filter: this.filter,
      activeSavedViewId: this.activeSavedViewId,
      savedViews: this.savedViews
    }
    void this.plugin.saveSettings()
  }

  /** Re-read every project from disk and rebuild the chart. */
  private async reload(): Promise<void> {
    if (this.loading) return
    this.loading = true
    try {
      this.sources = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
      this.render()
    } catch (e) {
      new Notice('Could not load the projects. Check the console.')
      console.error('[PM] UberProjectView: load failed', e)
    } finally {
      this.loading = false
    }
  }

  /**
   * A heading collapses locally; a real task's collapse is persisted against the project
   * that owns it, so it matches what that project's own view shows. Either way this
   * re-renders rather than reloading — collapsing shouldn't re-read every project file.
   */
  /**
   * Expand/collapse all: heading rows are ours, and every other row's flag belongs to the
   * project that owns it — the rendered tree holds filtered copies, so writing to those
   * would be discarded on the next render.
   */
  private async setAllCollapsed(uber: UberProject, collapsed: boolean): Promise<void> {
    const owners = new Set<Project>()
    for (const heading of uber.project.tasks) {
      if (collapsed) this.collapsedHeadings.add(heading.id)
      else this.collapsedHeadings.delete(heading.id)
      for (const { task } of flattenTasks(heading.subtasks)) {
        if (!task.subtasks.length) continue
        const owner = uber.ownerOf.get(task.id)
        const original = owner ? findTask(owner.tasks, task.id) : null
        if (!owner || !original) continue
        original.collapsed = collapsed
        owners.add(owner)
      }
    }
    for (const owner of owners) await this.plugin.persistCollapsedState(owner)
    this.render()
  }

  /**
   * The same header a project gets: search, saved views, the filter and timeline toggles,
   * and the conflict indicator. Built from PrimaryRow + FilterRow rather than
   * ProjectHeader, which also edits a project's title and description — there's no single
   * project here to edit.
   */
  private renderHeader(full: Project, roster: Map<string, string>): void {
    this.headerEl.empty()
    // Saved views are kept beside the filter in settings: this view has no project file to
    // put them in, but a saved "my week" is exactly what it's for.
    full.savedViews = this.savedViews
    this.primary = new PrimaryRow(this.headerEl, {
      project: full,
      filter: this.filter,
      activeSavedViewId: this.activeSavedViewId,
      filterRowExpanded: this.headerUi.filterOpen,
      viewMode: 'gantt',
      ganttControlsVisible: this.plugin.settings.ganttControlsVisible,
      onSearchChange: () => {
        this.saveFilter()
        this.render()
      },
      onSavedViewSelect: (id) => {
        const view = this.savedViews.find((v) => v.id === id)
        this.activeSavedViewId = id
        this.filter = view ? { ...makeDefaultFilter(), ...view.filter } : makeDefaultFilter()
        this.saveFilter()
        this.render()
      },
      onSavedViewSave: (name) => {
        const view: SavedView = { id: makeId(), name, filter: { ...this.filter }, sortKey: '', sortDir: 'asc' }
        this.savedViews = [...this.savedViews, view]
        this.activeSavedViewId = view.id
        this.saveFilter()
        this.render()
        return Promise.resolve()
      },
      onSavedViewUpdate: (id) => {
        this.savedViews = this.savedViews.map((v) => (v.id === id ? { ...v, filter: { ...this.filter } } : v))
        this.saveFilter()
        this.render()
        return Promise.resolve()
      },
      onSavedViewDelete: (id) => {
        this.savedViews = this.savedViews.filter((v) => v.id !== id)
        if (this.activeSavedViewId === id) this.activeSavedViewId = null
        this.saveFilter()
        this.render()
        return Promise.resolve()
      },
      onToggleConflicts: () => {
        this.plugin.settings.ganttConflictsOnly = !this.plugin.settings.ganttConflictsOnly
        void this.plugin.saveSettings()
        this.render()
      },
      onToggleGanttControls: () => {
        this.plugin.settings.ganttControlsVisible = !this.plugin.settings.ganttControlsVisible
        void this.plugin.saveSettings()
        this.render()
      },
      onToggleFilterRow: () => {
        this.headerUi.filterOpen = !this.headerUi.filterOpen
        this.render()
      }
    })
    this.primary.setConflicts(
      computeResourceConflicts(flattenTasks(full.tasks), this.plugin.settings.statuses).count,
      this.plugin.settings.ganttConflictsOnly
    )

    this.filterEl.empty()
    this.filterEl.toggleClass('pm-hidden', !this.headerUi.filterOpen)
    new FilterRow(this.filterEl, {
      project: full,
      statuses: this.plugin.settings.statuses,
      priorities: this.plugin.settings.priorities,
      roster,
      filter: this.filter,
      uiState: this.headerUi,
      onFilterChange: () => {
        this.saveFilter()
        this.render()
      },
      onClear: () => {
        this.filter = makeDefaultFilter()
        this.saveFilter()
        this.render()
      }
    })
  }

  private async toggleCollapsed(uber: UberProject, task: Task): Promise<void> {
    const owner = uber.headings.has(task.id) ? null : uber.ownerOf.get(task.id)
    if (owner) {
      // Tasks are shared by reference, so this flips the very object being rendered —
      // and persists against the right project file.
      await this.plugin.toggleTaskCollapsed(owner, task.id)
    } else {
      task.collapsed = !task.collapsed
      if (task.collapsed) this.collapsedHeadings.add(task.id)
      else this.collapsedHeadings.delete(task.id)
    }
    this.render()
  }

  private render(): void {
    // Filter each project's own tree, then build from what survived. Two reasons over
    // letting the chart filter: a project with nothing left is dropped entirely rather
    // than left as an empty heading, and the timeline is sized from the surviving dates —
    // a week-scoped view spans a week, not every project's full history.
    const statuses = this.plugin.settings.statuses
    const shown = new Map<Project, Task[]>()
    for (const source of this.sources) {
      const tasks = applyTaskFilterPromote(source.tasks, this.filter, statuses)
      if (tasks.length) shown.set(source, tasks)
    }
    // The real project objects go in — `ownerOf` has to resolve to them, not to copies
    // carrying only the filtered tasks.
    const uber = buildUberProject([...shown.keys()], (source) => shown.get(source) ?? [])
    this.uber = uber

    // The filter chips and the avatar initials must come from everything, not from what
    // survived the filter: chips built from the filtered set would strand you on one
    // assignee with no way back, and initials are meant to be stable whatever is showing.
    const full = buildUberProject(this.sources)
    const roster = projectRoster(full.project, this.plugin.settings)
    // Heading collapse is ours to restore — it isn't persisted per project file, and the
    // rows are rebuilt on every render.
    for (const heading of uber.project.tasks) {
      heading.collapsed = this.collapsedHeadings.has(heading.id)
      // A project row's dial shows how far the project has got, counted the way the
      // dashboard card counts it. Over the project's whole tree, not the filtered subset:
      // progress doesn't depend on what you happen to be looking at.
      const owner = uber.ownerOf.get(heading.id)
      const all = owner ? countTasks(owner.tasks, false, statuses) : 0
      const done = owner ? countTasks(owner.tasks, true, statuses) : 0
      heading.progress = all ? Math.round((done / all) * 100) : 0
    }

    this.renderHeader(full.project, roster)
    this.bodyEl.empty()
    this.gantt?.destroy?.()
    this.gantt = new GanttView(this.bodyEl, uber.project, this.plugin, () => this.reload(), makeDefaultFilter(), {
      readOnly: true,
      roster,
      // A task's real home, so the editor writes to the right project file.
      ownerOf: (task: Task) => uber.ownerOf.get(task.id) ?? uber.project,
      // A heading row is a project, not a task: open the project rather than a task
      // editor for something that has no dates, no status and no assignee.
      // Each project row in its own colour, so the groups are scannable at a glance —
      // and because a project row has no status worth colouring by.
      rowColorOf: (task: Task) => (uber.headings.has(task.id) ? uber.ownerOf.get(task.id)?.color : undefined),
      // A project row carries the project's own badge — its Jira root issue — not a task's.
      badgesOf: (task: Task) => {
        const owner = uber.ownerOf.get(task.id)
        if (!owner) return []
        return uber.headings.has(task.id)
          ? this.plugin.connectors.projectBadges(owner)
          : this.plugin.connectors.taskBadges(owner, task)
      },
      onOpenTask: (task: Task) => {
        if (!uber.headings.has(task.id)) return false
        const owner = uber.ownerOf.get(task.id)
        if (owner) void this.plugin.router.openProjectByPath(owner.filePath)
        return true
      },
      onToggleCollapsed: (task: Task) => this.toggleCollapsed(uber, task),
      onSetAllCollapsed: (collapsed: boolean) => this.setAllCollapsed(uber, collapsed)
    })
    this.gantt.render()
  }
}
