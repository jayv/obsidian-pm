import { ItemView, WorkspaceLeaf, ButtonComponent, Notice } from 'obsidian'
import type PMPlugin from '../main'
import { makeDefaultFilter, type FilterState, type Project, type Task } from '../types'
import { buildUberProject, type UberProject } from '../store/UberProject'
import { applyTaskFilterPromote } from '../store/TaskFilter'
import { findTask, flattenTasks } from '../store/TaskTreeOps'
import { projectRoster } from '../ui/roster'
import { FilterRow } from '../ui/composites/ProjectHeader/FilterRow'
import type { HeaderUiState } from '../ui/composites/ProjectHeader/ProjectHeader'
import { GanttView } from './gantt/GanttView'

/**
 * Filter state key. Not a real path — `projectFilters` is keyed by project file, and this
 * view has no file. A leading "::" can't collide with a vault path.
 */
const UBER_FILTER_KEY = '::all-projects'

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
  private toolbarEl!: HTMLElement
  private bodyEl!: HTMLElement
  private sources: Project[] = []
  private uber: UberProject | null = null
  private gantt: GanttView | null = null
  private filter: FilterState = makeDefaultFilter()
  private headerUi: HeaderUiState = { filterOpen: true, assigneeZoneOpen: true }
  private filterEl!: HTMLElement
  private loading = false
  private maximized = false
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
    this.toolbarEl = root.createDiv('pm-toolbar')
    this.filterEl = root.createDiv('pm-uber-filter')
    this.bodyEl = root.createDiv('pm-content')
    this.filter = this.loadFilter()
    await this.reload()
  }

  onClose(): Promise<void> {
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
    this.plugin.settings.projectFilters[UBER_FILTER_KEY] = { filter: this.filter, activeSavedViewId: null }
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

  private renderFilter(full: Project, roster: Map<string, string>): void {
    this.filterEl.empty()
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
    for (const heading of uber.project.tasks) heading.collapsed = this.collapsedHeadings.has(heading.id)

    this.renderFilter(full.project, roster)
    this.toolbarEl.empty()
    this.toolbarEl.createSpan({
      cls: 'pm-uber-title',
      text: `All projects · ${uber.sources.length} of ${this.sources.length} shown`
    })
    this.toolbarEl.createSpan({
      cls: 'pm-uber-hint',
      text: 'Read-only — open a task to edit it · shift+wheel or +/-/0 to zoom'
    })
    new ButtonComponent(this.toolbarEl).setButtonText('Reload').onClick(() => void this.reload())

    this.bodyEl.empty()
    this.gantt?.destroy?.()
    this.gantt = new GanttView(this.bodyEl, uber.project, this.plugin, () => this.reload(), makeDefaultFilter(), {
      readOnly: true,
      roster,
      // No project header here, so the Timeline toggle that normally reveals the
      // granularity bar doesn't exist — and granularity is the main control when planning.
      showControls: true,
      // A task's real home, so the editor writes to the right project file.
      ownerOf: (task: Task) => uber.ownerOf.get(task.id) ?? uber.project,
      // A heading row is a project, not a task: open the project rather than a task
      // editor for something that has no dates, no status and no assignee.
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
