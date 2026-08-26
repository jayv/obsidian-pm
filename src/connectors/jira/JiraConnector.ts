/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { ButtonComponent, ExtraButtonComponent, Notice } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task, TaskBadge } from '../../types'
import type { Connector, ConnectorDescriptor } from '../registry'
import { renderPropRow } from '../../ui/FormField'
import { setJiraApiDebug } from './JiraClient'
import { ensureMockServer, stopMockServer } from './JiraMockServer'
import { JIRA_ID, getDebug, projectCfg, serverById, sharedAssignees, taskExt } from './types'
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
import { hasConflicts, renameAcrossProjects, runSync } from './sync'
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
    setJiraApiDebug(getDebug(plugin)) // apply the saved API debug-logging preference
    // Host the JIRA mock over HTTP only when a "localhost" server is configured
    // (and Node is available). Idempotent; re-checked at each client entry point.
    void ensureMockServer(plugin, 'MOCK')
    plugin.register(() => stopMockServer())
  }

  isEnabled(project: Project): boolean {
    return Boolean(projectCfg(project)?.enabled)
  }

  /**
   * Migrate on load: pull any mapping still held on the project into the server-wide list.
   * Without this the settings dialog would read empty until the project had been synced or
   * its panel opened, which looks exactly like the mappings having been lost.
   */
  onProjectLoaded(project: Project): void {
    const cfg = projectCfg(project)
    if (cfg?.serverId) sharedAssignees(this.plugin, cfg)
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
    if (!cfg) return
    renameAssigneeMapping(sharedAssignees(this.plugin, cfg), from, to)
    void this.plugin.saveSettings() // the map lives in plugin settings, not the project
    // renameAcrossProjects guards its own re-entry: renaming each project fires this
    // hook again, and only the outermost walk does the work.
    void renameAcrossProjects(this.plugin, cfg.serverId, from, to, project.filePath)
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
        const key = ext.key
        const site = serverById(this.plugin, cfg.serverId)?.site
        const url = site ? `https://${site}/browse/${key}` : ''
        const a = wrap.createEl('a', { text: ` ${key}`, cls: 'pm-prop-jira-key', href: url || '#' })
        a.setAttr('target', '_blank')

        // Two things get pasted often and they aren't interchangeable: the key for a
        // commit message or a chat, the URL for anywhere that wants a link. Distinct
        // icons rather than two clipboards, and each tooltip names what lands on the
        // clipboard so there's no guessing which is which.
        const copy = (what: string, value: string, icon: string): void => {
          new ExtraButtonComponent(wrap)
            .setIcon(icon)
            .setTooltip(`Copy ${what}: ${value}`)
            .onClick(() => {
              void navigator.clipboard.writeText(value)
              new Notice(`Copied ${value}`)
            })
        }
        copy('the issue key', key, 'hash')
        if (url) copy('the link', url, 'link')
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
