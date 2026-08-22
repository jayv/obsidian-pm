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
      this.render()
    } catch (e) {
      new Notice('Could not load the projects. Check the console.')
      console.error('[PM] UberProjectView: load failed', e)
    } finally {
      this.loading = false
    }
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
      ownerOf: (task: Task) => uber.ownerOf.get(task.id) ?? uber.project
    })
    this.gantt.render()
  }
}
