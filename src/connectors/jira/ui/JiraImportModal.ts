/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { App, ButtonComponent, Modal, Notice } from 'obsidian'
import type PMPlugin from '../../../main'
import type { Project, Task } from '../../../types'
import { getStatusConfig, safeAsync } from '../../../utils'
import { flattenTasks } from '../../../store/TaskTreeOps'
import { IconButton } from '../../../ui/primitives/IconButton'
import type { JiraIssue } from '../JiraModel'
import { mapInbound } from '../JiraModel'
import {
  autoMatchByTitle,
  fetchEpicStories,
  hasConflicts,
  importedKeys,
  importStories,
  linkStoriesToTasks,
  updateIgnoredKeys
} from '../sync'
import { projectCfg, serverById, taskExt } from '../types'
import { pickAssigneeCell, pickDueCell, pickStatusCell, renderPickTable } from './pickTable'
import { JiraMergeModal } from './JiraMergeModal'
import { JiraMatchSearchModal } from './JiraMatchSearchModal'

/**
 * Pick which of an epic's issues to import. Already-imported and previously-ignored
 * issues are hidden by default; unchecked issues are added to the ignore list.
 */
export class JiraImportModal extends Modal {
  private stories: JiraIssue[] = []
  private picks = new Map<string, boolean>()
  /** issue key → existing (keyless) task id to link it to, instead of creating a new task. */
  private matches = new Map<string, string>()
  private showIgnored = false

  constructor(
    app: App,
    private plugin: PMPlugin,
    private project: Project,
    private onDone: () => void | Promise<void>
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('pm-modal', 'pm-modal--project', 'pm-jira-pick-modal')
    this.contentEl.empty()
    this.contentEl.addClass('pm-project-modal')
    this.contentEl.createEl('h2', { text: 'Import Jira tasks', cls: 'pm-modal-heading' })
    const status = this.contentEl.createDiv('pm-jira-result')
    status.setText('Loading issues from Jira…')
    void this.load(status)
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private async load(status: HTMLElement): Promise<void> {
    try {
      this.stories = await fetchEpicStories(this.plugin, this.project)
    } catch (e) {
      status.setText('Failed to load issues. Check the console.')
      console.error('JiraImport: load failed', e)
      return
    }
    status.remove()
    // Pre-link issues to existing unlinked tasks with the same title, so a re-import of
    // something you already track reconciles instead of duplicating. The user can unlink.
    const tasks = flattenTasks(this.project.tasks).map((f) => f.task)
    for (const [key, taskId] of autoMatchByTitle(this.stories, tasks)) {
      this.matches.set(key, taskId)
    }
    this.render()
  }

  private visibleStories(): JiraIssue[] {
    const already = importedKeys(this.project)
    const ignored = new Set(projectCfg(this.project)?.ignoredKeys ?? [])
    return this.stories.filter((s) => !already.has(s.key) && (this.showIgnored || !ignored.has(s.key)))
  }

  private render(): void {
    const el = this.contentEl
    el.querySelector('.pm-jira-import-body')?.remove()
    const body = el.createDiv('pm-jira-import-body')

    const visible = this.visibleStories()
    const cfg = projectCfg(this.project)
    const statuses = this.plugin.settings.statuses
    const site = serverById(this.plugin, cfg?.serverId ?? '')?.site ?? ''
    // Unlinked (keyless) local tasks are the candidates to match an incoming issue against.
    const taskById = new Map(
      flattenTasks(this.project.tasks)
        .filter((f) => !taskExt(f.task).key)
        .map((f) => [f.task.id, f.task])
    )
    renderPickTable<JiraIssue>({
      parent: body,
      items: visible,
      keyOf: (s) => s.key,
      picks: this.picks,
      empty: 'No new issues to import.',
      columns: [
        {
          header: 'Jira ID',
          cls: 'pm-pick-key',
          render: (s, td) => {
            const a = td.createEl('a', { text: s.key, href: site ? `https://${site}/browse/${s.key}` : '#' })
            a.setAttr('target', '_blank')
          }
        },
        { header: 'Title', cls: 'pm-pick-title', render: (s, td) => td.setText(s.summary || s.key) },
        {
          header: 'Link',
          cls: 'pm-pick-match',
          render: (s: JiraIssue, td: HTMLElement) => this.renderLinkCell(s, td, taskById)
        },
        {
          header: 'Status',
          cls: 'pm-pick-status',
          render: (s, td) => {
            // Colour like the grid when the Jira status maps to one of ours; else neutral.
            const ourId = mapInbound(cfg?.statusMap, s.status, '')
            const sc = ourId ? getStatusConfig(statuses, ourId) : undefined
            pickStatusCell(td, sc?.label ?? s.status, { color: sc?.color, icon: sc?.icon })
          }
        },
        { header: 'Assignee', cls: 'pm-pick-assignee', render: (s, td) => pickAssigneeCell(td, s.assigneeName) },
        {
          header: 'Due',
          cls: 'pm-pick-due',
          render: (s, td) => pickDueCell(td, s.due, s.statusCategory === 'Done')
        }
      ],
      afterRow: (s, row) => this.renderLinkedSubRow(s, row, taskById)
    })

    el.querySelector('.pm-modal-footer')?.remove()
    const footer = el.createDiv('pm-modal-footer')
    const ignoredCount = (projectCfg(this.project)?.ignoredKeys ?? []).length
    if (ignoredCount) {
      const showWrap = footer.createDiv('pm-jira-showignored')
      const sc = showWrap.createEl('input', { type: 'checkbox' })
      sc.checked = this.showIgnored
      showWrap.createEl('label', { text: `Show ${ignoredCount} ignored` })
      sc.addEventListener('change', () => {
        this.showIgnored = sc.checked
        this.render()
      })
    }
    footer.createDiv('pm-footer-spacer')
    new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close())
    new ButtonComponent(footer)
      .setButtonText('Import selected')
      .setCta()
      .onClick(safeAsync(() => this.doImport(visible)))
  }

  /**
   * A chain-link icon to link this incoming issue to an existing unlinked task: opens a
   * search dialog; once linked the icon becomes "unlink" (which clears the match and its
   * sub-row, back to "import as new").
   */
  private renderLinkCell(s: JiraIssue, td: HTMLElement, taskById: Map<string, Task>): void {
    const matchedId = this.matches.get(s.key)
    const btn = new IconButton(td)
    if (matchedId) {
      btn
        .setIcon('unlink')
        .setTooltip('Unlink — import as a new task')
        .onClick(() => {
          this.matches.delete(s.key)
          this.render()
        })
      return
    }
    btn
      .setIcon('link')
      .setTooltip('Link to an existing task…')
      .onClick(() => {
        const used = new Set(this.matches.values())
        const available = [...taskById.values()].filter((t) => !used.has(t.id))
        if (!available.length) {
          new Notice('No unlinked tasks to match.')
          return
        }
        new JiraMatchSearchModal(this.plugin.app, this.plugin, this.project, available, (taskId) => {
          this.matches.set(s.key, taskId)
          this.picks.set(s.key, true) // a linked row is always acted on
          this.render()
        }).open()
      })
  }

  /** When an issue is linked to a task, show that task's fields as a sub-row beneath it. */
  private renderLinkedSubRow(s: JiraIssue, row: HTMLTableRowElement, taskById: Map<string, Task>): void {
    const task = taskById.get(this.matches.get(s.key) ?? '')
    if (!task) return
    const sub = createEl('tr', { cls: 'pm-jira-match-subrow' })
    const cell = sub.createEl('td', { attr: { colspan: String(row.cells.length) } })
    const wrap = cell.createDiv('pm-jira-match-linked')
    wrap.createSpan({ text: '↳ links to', cls: 'pm-jira-match-linked-label' })
    wrap.createSpan({ text: task.title || '(untitled)', cls: 'pm-jira-match-linked-title' })
    const sc = getStatusConfig(this.plugin.settings.statuses, task.status)
    pickStatusCell(wrap.createSpan(), sc?.label ?? task.status, { color: sc?.color, icon: sc?.icon })
    pickAssigneeCell(wrap.createSpan(), task.assignees[0])
    pickDueCell(wrap.createSpan(), task.due)
    row.after(sub)
  }

  private async doImport(visible: JiraIssue[]): Promise<void> {
    const selected = visible.filter((s) => this.picks.get(s.key))
    const rejected = visible.filter((s) => !this.picks.get(s.key)).map((s) => s.key)

    // Split into "link to an existing task" vs "create new". A given task can only be
    // matched once; extra matches to the same task fall back to creating new.
    const pairs: { issueKey: string; taskId: string }[] = []
    const usedTasks = new Set<string>()
    const toCreate: JiraIssue[] = []
    for (const s of selected) {
      const taskId = this.matches.get(s.key)
      if (taskId && !usedTasks.has(taskId)) {
        pairs.push({ issueKey: s.key, taskId })
        usedTasks.add(taskId)
      } else {
        toCreate.push(s)
      }
    }

    // Ignore only *new* unpicked issues. Anything acted on (imported or linked) and any
    // revealed already-ignored issue left unpicked is un-ignored — back to the pending list.
    const wasIgnored = new Set(projectCfg(this.project)?.ignoredKeys ?? [])
    const add = rejected.filter((k) => !wasIgnored.has(k))
    const remove = [...selected.map((s) => s.key), ...rejected.filter((k) => wasIgnored.has(k))]
    await updateIgnoredKeys(this.plugin, this.project, { add, remove })
    const { created } = await importStories(this.plugin, this.project, toCreate)
    const { linked, conflicted } = pairs.length
      ? await linkStoriesToTasks(this.plugin, this.project, pairs)
      : { linked: 0, conflicted: 0 }

    const parts: string[] = []
    if (created) parts.push(`imported ${created}`)
    if (linked) parts.push(`linked ${linked}`)
    new Notice(parts.length ? `Jira: ${parts.join(', ')}.` : 'Nothing imported.')
    await this.onDone()
    this.close()
    // Matches whose fields diverged are flagged — open the resolver so they're not missed.
    if (conflicted && hasConflicts(this.project)) {
      new JiraMergeModal(this.plugin.app, this.plugin, this.project, () => this.plugin.refreshProjectViews()).open()
    }
  }
}
