import { ItemView, WorkspaceLeaf, ButtonComponent, Notice } from 'obsidian'
import type PMPlugin from '../main'
import { makeDefaultFilter, type FilterState, type Task } from '../types'
import { buildUberProject, type UberProject } from '../store/UberProject'
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
  private toolbarEl!: HTMLElement
  private bodyEl!: HTMLElement
  private uber: UberProject | null = null
  private gantt: GanttView | null = null
  private filter: FilterState = makeDefaultFilter()
  private loading = false
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
    this.bodyEl = root.createDiv('pm-content')
    await this.reload()
  }

  onClose(): Promise<void> {
    this.gantt?.destroy?.()
    return Promise.resolve()
  }

  /** Re-read every project from disk and rebuild the chart. */
  private async reload(): Promise<void> {
    if (this.loading) return
    this.loading = true
    try {
      const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
      this.uber = buildUberProject(projects)
      // Real tasks get their collapsed flag from loadProject (per project file); the
      // heading rows are ours to restore.
      for (const heading of this.uber.project.tasks) {
        heading.collapsed = this.collapsedHeadings.has(heading.id)
      }
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
    const uber = this.uber
    if (!uber) return

    this.toolbarEl.empty()
    this.toolbarEl.createSpan({
      cls: 'pm-uber-title',
      text: `All projects · ${uber.sources.length} project${uber.sources.length === 1 ? '' : 's'}`
    })
    this.toolbarEl.createSpan({ cls: 'pm-uber-hint', text: 'Read-only — open a task to edit it' })
    new ButtonComponent(this.toolbarEl).setButtonText('Reload').onClick(() => void this.reload())

    this.bodyEl.empty()
    this.gantt?.destroy?.()
    this.gantt = new GanttView(this.bodyEl, uber.project, this.plugin, () => this.reload(), this.filter, {
      readOnly: true,
      // A task's real home, so the editor writes to the right project file.
      ownerOf: (task: Task) => uber.ownerOf.get(task.id) ?? uber.project,
      onToggleCollapsed: (task: Task) => this.toggleCollapsed(uber, task)
    })
    this.gantt.render()
  }
}
