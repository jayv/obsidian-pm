/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { App, ButtonComponent, Modal, Notice } from 'obsidian'
import type PMPlugin from '../../../main'
import { projectRoster } from '../../../ui/roster'
import type { Project } from '../../../types'
import { getStatusConfig, isTerminalStatus, safeAsync } from '../../../utils'
import { exportTasks, exportableTasks, type ExportCandidate } from '../sync'
import { pickAssigneeCell, pickDueCell, pickStatusCell, renderPickTable } from './pickTable'

/**
 * Pick which not-yet-linked tasks to push to JIRA as new issues. Mirror of
 * {@link JiraImportModal}: every keyless task is listed and selected by default;
 * exporting creates the issues and links the tasks back to their new keys.
 */
export class JiraExportModal extends Modal {
  private tasks: ExportCandidate[] = []
  private picks = new Map<string, boolean>()

  constructor(
    app: App,
    private plugin: PMPlugin,
    private project: Project,
    private onDone: () => void | Promise<void>
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
    this.contentEl.createEl('h2', { text: 'Export tasks to Jira', cls: 'pm-modal-heading' })
    this.tasks = exportableTasks(this.project)
    this.render()
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private render(): void {
    const el = this.contentEl
    el.querySelector('.pm-jira-import-body')?.remove()
    const body = el.createDiv('pm-jira-import-body')

    const statuses = this.plugin.settings.statuses
    renderPickTable<ExportCandidate>({
      parent: body,
      items: this.tasks,
      keyOf: (t) => t.id,
      picks: this.picks,
      empty: 'All tasks are already linked to Jira.',
      columns: [
        {
          header: 'Title',
          cls: 'pm-pick-title',
          render: (t, td) => td.setText(`${t.title}${t.type === 'milestone' ? '  ◆' : ''}`)
        },
        {
          header: 'Status',
          cls: 'pm-pick-status',
          render: (t, td) => {
            const cfg = getStatusConfig(statuses, t.status)
            pickStatusCell(td, cfg?.label ?? t.status, { color: cfg?.color, icon: cfg?.icon })
          }
        },
        {
          header: 'Assignee',
          cls: 'pm-pick-assignee',
          render: (t, td) => pickAssigneeCell(td, t.assignees[0], this.roster())
        },
        {
          header: 'Due',
          cls: 'pm-pick-due',
          render: (t, td) => pickDueCell(td, t.due, isTerminalStatus(t.status, statuses))
        }
      ]
    })

    el.querySelector('.pm-modal-footer')?.remove()
    const footer = el.createDiv('pm-modal-footer')
    footer.createDiv('pm-footer-spacer')
    new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close())
    new ButtonComponent(footer)
      .setButtonText('Export selected')
      .setCta()
      .onClick(safeAsync(() => this.doExport()))
  }

  private async doExport(): Promise<void> {
    const ids = this.tasks.filter((t) => this.picks.get(t.id)).map((t) => t.id)
    if (!ids.length) {
      this.close()
      return
    }
    const { created, skipped } = await exportTasks(this.plugin, this.project, ids)
    const tail = skipped.length ? ` ${skipped.length} too deeply nested to create.` : ''
    new Notice((created ? `Exported ${created} task${created === 1 ? '' : 's'} to Jira.` : 'Nothing exported.') + tail)
    await this.onDone()
    this.close()
  }
}
