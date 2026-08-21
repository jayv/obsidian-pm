/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { ButtonComponent, Notice } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task, TaskBadge } from '../../types'
import type { Connector, ConnectorDescriptor } from '../registry'
import { renderPropRow } from '../../ui/FormField'
import { ProjectView } from '../../views/ProjectView'
import { setJiraApiDebug } from './JiraClient'
import { ensureMockServer, stopMockServer } from './JiraMockServer'
import { JIRA_ID, getDebug, projectCfg, serverById, taskExt } from './types'
import {
  defaultNewTaskSync,
  dueForSync,
  ignoreOnDelete,
  isLinkChecked,
  linkTask,
  queueDirty,
  renameAssigneeMapping,
  unlinkTask
} from './taskLink'
import { hasConflicts, runSync } from './sync'
import { renderJiraGlobalSettings } from './ui/JiraGlobalSettings'
import { renderJiraProjectPanel } from './ui/JiraProjectPanel'
import { JiraImportModal } from './ui/JiraImportModal'
import { JiraMergeModal } from './ui/JiraMergeModal'
import { SyncProgress } from './ui/SyncProgress'

/** The JIRA integration as a self-contained connector (read-only / dry-run). */
export class JiraConnector implements Connector {
  readonly id = JIRA_ID
  readonly name = 'Jira'

  constructor(private plugin: PMPlugin) {}

  onload(plugin: PMPlugin): void {
    plugin.addCommand({
      id: 'jira-sync-now',
      name: 'Jira: sync active project now',
      // eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- deliberate: Mod+Shift+S syncs, only active when a Jira-enabled project view is focused
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 's' }],
      checkCallback: (checking: boolean) => {
        const project = plugin.app.workspace.getActiveViewOfType(ProjectView)?.project
        if (!project || !this.isEnabled(project)) return false
        if (!checking) void this.syncNow(project)
        return true
      }
    })

    setJiraApiDebug(getDebug(plugin)) // apply the saved API debug-logging preference
    // Host the JIRA mock over HTTP only when a "localhost" server is configured
    // (and Node is available). Idempotent; re-checked at each client entry point.
    void ensureMockServer(plugin, 'MOCK')
    plugin.register(() => stopMockServer())
  }

  isEnabled(project: Project): boolean {
    return Boolean(projectCfg(project)?.enabled)
  }

  onTaskChanged(project: Project, task: Task): void {
    const cfg = projectCfg(project)
    if (cfg) queueDirty(cfg, task)
  }

  /**
   * A synced task was deleted in Obsidian. We never delete the Jira issue — instead
   * add its key to `ignoredKeys` so the next sync leaves the issue alone and stops
   * re-offering it for import. The store persists the project right after this fires.
   */
  onTaskDeleted(project: Project, task: Task): void {
    const cfg = projectCfg(project)
    if (cfg) ignoreOnDelete(cfg, task)
  }

  /**
   * A team member was renamed. The assignee map is keyed by the member's name, so the
   * entry has to move with them — otherwise the rename reads as a brand-new, unmapped
   * member and assignment sync silently stops for them.
   */
  onAssigneeRenamed(project: Project, from: string, to: string): void {
    const cfg = projectCfg(project)
    if (cfg) renameAssigneeMapping(cfg.assigneeMap, from, to)
  }

  /**
   * The linked Jira issue key, shown as a pill in the table, the gantt label column and
   * on kanban cards. Carries the browse URL so it opens the issue, like the task editor's
   * key link — omitted when the project's server has no site configured.
   */
  taskBadge(task: Task, project: Project): TaskBadge | null {
    const key = taskExt(task).key
    if (!key) return null
    const site = serverById(this.plugin, projectCfg(project)?.serverId ?? '')?.site
    return { label: key, href: site ? `https://${site}/browse/${key}` : undefined }
  }

  async syncTick(project: Project): Promise<{ changed: boolean }> {
    const cfg = projectCfg(project)
    if (!cfg?.enabled || !dueForSync(cfg, Date.now())) return { changed: false }
    // Periodic tick: incremental — only changes to tracked issues since the watermark,
    // no issue-type / epic-config metadata. Manual `syncNow` stays a full sync.
    return runSync(this.plugin, project, { full: false })
  }

  async syncNow(project: Project): Promise<void> {
    // A manual sync is many round-trips; show live progress so a slow instance doesn't
    // look frozen. The periodic tick stays silent.
    const progress = new SyncProgress()
    try {
      const r = await runSync(this.plugin, project, {
        onProgress: (phase, done, total) => progress.update(phase, done, total)
      })
      progress.hide()
      const lines = [
        'Jira sync complete',
        `  Created in Jira: ${r.jiraCreated}`,
        `  Updated in Jira: ${r.jiraUpdated}`,
        `  Created in Obsidian: ${r.newIssues.length}`,
        `  Updated in Obsidian: ${r.obsidianUpdated}`,
        `  Created Team Members: ${r.membersAdded}`,
        `  Conflicts: ${r.conflicts}`,
        ...(r.skippedTooDeep.length ? [`  Too deeply nested for Jira (not created): ${r.skippedTooDeep.length}`] : []),
        ...(r.skippedNoParent.length ? [`  Waiting on an unsynced parent: ${r.skippedNoParent.length}`] : [])
      ]
      new Notice(lines.join('\n'))
      this.plugin.refreshProjectViews()
      // Conflicts take priority — open the merge editor for all of them. Otherwise
      // offer to import (or ignore) issues that appeared on the JIRA side.
      if (hasConflicts(project)) {
        new JiraMergeModal(this.plugin.app, this.plugin, project, () => this.plugin.refreshProjectViews()).open()
      } else if (r.newIssues.length) {
        new JiraImportModal(this.plugin.app, this.plugin, project, () => this.plugin.refreshProjectViews()).open()
      }
    } catch (e) {
      new Notice('Jira sync failed. Check the console.')
      console.error('[PM] Jira sync failed', e)
    } finally {
      progress.hide() // never leave the popup behind on an early return or a throw
    }
  }

  renderGlobalSettings(containerEl: HTMLElement): void {
    renderJiraGlobalSettings(containerEl, this.plugin)
  }

  renderProjectPanel(containerEl: HTMLElement, project: Project, onClose: () => void, onChange?: () => void): void {
    renderJiraProjectPanel(containerEl, this.plugin, project, onClose, onChange)
  }

  renderTaskField(containerEl: HTMLElement, task: Task, project: Project): void {
    const cfg = projectCfg(project)
    if (!cfg?.enabled) return
    const isNew = !task.filePath
    defaultNewTaskSync(task, isNew) // new tasks sync by default (opt-in pre-checked)

    renderPropRow(containerEl, 'Jira', () => {
      const wrap = createDiv('pm-prop-value pm-prop-jira')
      const ext = taskExt(task)
      const cb = wrap.createEl('input', { type: 'checkbox' })
      cb.checked = isLinkChecked(task, isNew)
      cb.title = 'Sync this task with Jira'
      cb.addEventListener('change', () => {
        if (cb.checked) linkTask(task)
        else unlinkTask(task, cfg)
      })
      if (ext.key) {
        const site = serverById(this.plugin, cfg.serverId)?.site
        const a = wrap.createEl('a', {
          text: ` ${ext.key}`,
          cls: 'pm-prop-jira-key',
          href: site ? `https://${site}/browse/${ext.key}` : '#'
        })
        a.setAttr('target', '_blank')
      }
      if (ext.reconciled === false) wrap.createSpan({ text: ' ⚠ out of sync', cls: 'pm-jira-limbo-badge' })
      return wrap
    })
    if (taskExt(task).reconciled === false) this.renderReconcileRow(containerEl, task, project)
  }

  /** Warning row + a button that opens the per-field conflict resolver. */
  private renderReconcileRow(containerEl: HTMLElement, task: Task, project: Project): void {
    renderPropRow(containerEl, 'Jira', () => {
      const wrap = createDiv('pm-prop-value pm-jira-limbo')
      wrap.createDiv({
        text: 'Out of sync — Obsidian and Jira changed this task differently.',
        cls: 'pm-jira-limbo-text'
      })
      const actions = wrap.createDiv('pm-jira-limbo-actions')
      new ButtonComponent(actions).setButtonText('Resolve…').onClick(() => {
        new JiraMergeModal(
          this.plugin.app,
          this.plugin,
          project,
          () => this.plugin.refreshProjectViews(),
          task.id
        ).open()
      })
      return wrap
    })
  }
}

/** Lazy descriptor — the registry builds the connector on first use. */
export const jiraConnector: ConnectorDescriptor = {
  id: JIRA_ID,
  name: 'Jira',
  frontmatterKeys: { keys: [JIRA_ID] },
  create: (plugin) => new JiraConnector(plugin)
}
