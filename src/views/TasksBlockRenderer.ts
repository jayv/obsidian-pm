/**
 * Renders a `pm-tasks` block (see tasksBlock.ts for the parsing/selection half).
 *
 * A MarkdownRenderChild rather than a one-shot render: the panel sits in a note the user
 * keeps open — a homepage, today's daily note — and the tasks behind it change all day. It
 * re-reads on vault changes and tears its listeners down with the block.
 */
import { MarkdownRenderChild, TFile, setTooltip } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { openTaskModal } from '../ui/ModalFactory'
import { renderTaskBadges } from '../ui/primitives/TaskBadges'
import { findSavedView, groupByProject, parseTasksBlock, selectBlockTasks, uberSavedViews } from './tasksBlock'

export class TasksBlockRenderer extends MarkdownRenderChild {
  private timer: number | null = null

  constructor(
    containerEl: HTMLElement,
    private plugin: PMPlugin,
    private source: string
  ) {
    super(containerEl)
  }

  onload(): void {
    this.containerEl.addClass('pm-tasks-block')
    void this.render()
    // Any note in the vault can be a task; rather than work out which, redraw on a quiet
    // debounce after any markdown change. Cheap next to how often the user looks at it.
    const onChange = (file: unknown): void => {
      if (file instanceof TFile && file.extension !== 'md') return
      this.schedule()
    }
    const vault = this.plugin.app.vault
    this.registerEvent(vault.on('modify', onChange))
    this.registerEvent(vault.on('create', onChange))
    this.registerEvent(vault.on('delete', onChange))
    this.registerEvent(vault.on('rename', onChange))
  }

  onunload(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.render()
    }, 400)
  }

  private async render(): Promise<void> {
    const el = this.containerEl
    el.empty()

    const spec = parseTasksBlock(this.source)
    const views = uberSavedViews(this.plugin.settings.projectFilters)
    const saved = spec.view ? findSavedView(views, spec.view) : undefined

    if (spec.errors.length || !saved) {
      const problems = [...spec.errors]
      if (spec.view && !saved) problems.push(`no saved view named "${spec.view}"`)
      this.renderProblems(
        el,
        problems,
        views.map((v) => v.name)
      )
      return
    }

    const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    const rows = selectBlockTasks(projects, saved.filter, this.plugin.settings.statuses, spec.limit)

    const head = el.createDiv('pm-tasks-block-head')
    head.createSpan({ text: spec.title || saved.name, cls: 'pm-tasks-block-title' })
    head.createSpan({ text: String(rows.length), cls: 'pm-tasks-block-count' })

    if (!rows.length) {
      el.createDiv({ text: 'Nothing matches this view.', cls: 'pm-tasks-block-empty' })
      return
    }

    const list = el.createDiv('pm-tasks-block-list')
    if (spec.group === 'none') {
      for (const row of rows) this.renderRow(list, row.project, row.task, true)
      return
    }
    for (const group of groupByProject(rows)) {
      const header = list.createDiv('pm-tasks-block-group')
      header.createSpan({ cls: 'pm-tasks-block-group-dot' }).style.background = group.project.color
      header.createSpan({ text: group.project.title, cls: 'pm-tasks-block-group-name' })
      header.createSpan({ text: String(group.tasks.length), cls: 'pm-tasks-block-count' })
      for (const task of group.tasks) this.renderRow(list, group.project, task, false)
    }
  }

  /** One task. `withProject` names the project inline, for the ungrouped layout. */
  private renderRow(parent: HTMLElement, project: Project, task: Task, withProject: boolean): void {
    const row = parent.createDiv('pm-tasks-block-row')
    const status = this.plugin.settings.statuses.find((s) => s.id === task.status)
    const dot = row.createSpan({ cls: 'pm-tasks-block-dot' })
    dot.style.background = status?.color ?? 'var(--text-faint)'
    if (status) setTooltip(dot, status.label)

    row.createSpan({ text: task.title || '(untitled)', cls: 'pm-tasks-block-name' })
    if (withProject) row.createSpan({ text: project.title, cls: 'pm-tasks-block-project' })

    renderTaskBadges(row, this.plugin.connectors.taskBadges(project, task))
    if (task.due) row.createSpan({ text: task.due, cls: 'pm-tasks-block-due' })

    row.addEventListener('click', () => {
      openTaskModal(this.plugin, project, {
        task,
        onSave: async () => {
          await this.plugin.store.saveProject(project)
          this.plugin.refreshProjectViews()
          await this.render()
        }
      })
    })
  }

  /** Say what's wrong and what the valid answers are — an empty panel explains nothing. */
  private renderProblems(el: HTMLElement, problems: string[], viewNames: string[]): void {
    const box = el.createDiv('pm-tasks-block-error')
    box.createDiv({ text: 'pm-tasks', cls: 'pm-tasks-block-error-title' })
    const list = box.createEl('ul')
    for (const p of problems) list.createEl('li', { text: p })
    box.createDiv({
      cls: 'pm-tasks-block-error-hint',
      text: viewNames.length
        ? `Saved views on the all-projects timeline: ${viewNames.join(', ')}`
        : 'No saved views yet — open the all-projects timeline, set up a filter, and save it.'
    })
  }
}
