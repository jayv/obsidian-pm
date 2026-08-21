import { App, Modal } from 'obsidian'
import type PMPlugin from '../../../main'
import { projectRoster } from '../../../ui/roster'
import type { Project, Task } from '../../../types'
import { makeDefaultFilter } from '../../../types'
import { matchesFilter } from '../../../store/TaskFilter'
import { getStatusConfig } from '../../../utils'
import { pickAssigneeCell, pickDueCell, pickStatusCell } from './pickTable'

/**
 * Search the project's unlinked tasks to pick one to link an incoming Jira issue to.
 * Reuses the app's built-in task search (matchesFilter over the query) and shows the same
 * columns as the import grid. Selecting a row resolves its task id.
 */
export class JiraMatchSearchModal extends Modal {
  private query = ''

  constructor(
    app: App,
    private plugin: PMPlugin,
    private project: Project,
    private candidates: Task[],
    private onPick: (taskId: string) => void
  ) {
    super(app)
  }

  /** Avatar initials matching the project's own views — see projectRoster. */
  private roster(): Map<string, string> {
    return projectRoster(this.project, this.plugin.settings)
  }

  onOpen(): void {
    this.modalEl.addClass('pm-modal', 'pm-modal--project', 'pm-jira-pick-modal')
    this.contentEl.empty()
    this.contentEl.addClass('pm-project-modal')
    this.contentEl.createEl('h2', { text: 'Link to an existing task', cls: 'pm-modal-heading' })

    const input = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'pm-input',
      attr: { placeholder: 'Search tasks…' }
    })
    input.addEventListener('input', () => {
      this.query = input.value
      this.renderResults()
    })
    this.contentEl.createDiv('pm-jira-match-results')
    this.renderResults()
    window.setTimeout(() => input.focus(), 30)
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private matches(): Task[] {
    const filter = { ...makeDefaultFilter(), text: this.query.trim() }
    const statuses = this.plugin.settings.statuses
    return this.candidates.filter((t) => matchesFilter(t, filter, statuses))
  }

  private renderResults(): void {
    const host = this.contentEl.querySelector<HTMLElement>('.pm-jira-match-results')
    if (!host) return
    host.empty()
    const rows = this.matches()
    if (!rows.length) {
      host.createDiv('pm-modal-hint').setText(this.candidates.length ? 'No matching tasks.' : 'No unlinked tasks.')
      return
    }
    const statuses = this.plugin.settings.statuses
    const table = host.createEl('table', { cls: 'pm-jira-pick-table' })
    const head = table.createEl('thead').createEl('tr')
    for (const h of ['Title', 'Status', 'Assignee', 'Due']) head.createEl('th', { text: h })
    const tbody = table.createEl('tbody')
    for (const task of rows) {
      const tr = tbody.createEl('tr', { cls: 'pm-jira-match-row' })
      tr.createEl('td', { text: task.title || '(untitled)', cls: 'pm-pick-title' })
      const sc = getStatusConfig(statuses, task.status)
      pickStatusCell(tr.createEl('td', { cls: 'pm-pick-status' }), sc?.label ?? task.status, {
        color: sc?.color,
        icon: sc?.icon
      })
      pickAssigneeCell(tr.createEl('td', { cls: 'pm-pick-assignee' }), task.assignees[0], this.roster())
      pickDueCell(tr.createEl('td', { cls: 'pm-pick-due' }), task.due)
      tr.addEventListener('click', () => {
        this.onPick(task.id)
        this.close()
      })
    }
  }
}
