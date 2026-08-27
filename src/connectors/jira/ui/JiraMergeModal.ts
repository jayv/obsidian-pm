/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { App, ButtonComponent, Modal } from 'obsidian'
import type PMPlugin from '../../../main'
import type { Project, Task } from '../../../types'
import { flattenTasks } from '../../../store/TaskTreeOps'
import { safeAsync } from '../../../utils'
import { type SyncField, conflictFields } from '../reconcile'
import { localParentKey, resolveConflict, shadowOf } from '../sync'
import type { JiraShadow } from '../types'
import { taskExt } from '../types'
import { FIELD_LABEL, formatField } from './conflictFormat'
import { JiraTextCompareModal } from './JiraTextCompareModal'

/** A conflicted task plus the three sides of its merge. */
interface MergeItem {
  task: Task
  mine: JiraShadow
  base: JiraShadow | undefined
  theirs: JiraShadow
  /** Fields where BOTH sides changed (or a match with no common base) — the genuine
   *  conflicts that need a per-field decision. */
  decisions: SyncField[]
  /** Fields only Jira changed (mine == base) — merged in silently, never shown. */
  autoTheirs: SyncField[]
}

/**
 * A wide, two-pane merge-conflict editor for JIRA sync: conflicted tasks listed in a
 * left sidebar, each resolved in a 3-way diff (Obsidian | last-synced base | Jira) like
 * vscode/meld. Per field you pick the Obsidian or the Jira side; base is the read-only
 * common ancestor. Resolving a task removes it from the list and advances to the next.
 */
export class JiraMergeModal extends Modal {
  private items: MergeItem[] = []
  private selected = 0
  /** Per task id → per field → true = take Jira, false = keep Obsidian. */
  private choices = new Map<string, Map<SyncField, boolean>>()

  constructor(
    app: App,
    private plugin: PMPlugin,
    private project: Project,
    private onDone: () => void | Promise<void>,
    /** Optionally focus a specific task first (e.g. the per-task "Resolve…" button). */
    private focusTaskId?: string
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('pm-modal', 'pm-jira-merge-modal')
    this.contentEl.addClass('pm-jira-merge')
    this.rebuild()
    if (this.focusTaskId) {
      const i = this.items.findIndex((it) => it.task.id === this.focusTaskId)
      if (i >= 0) this.selected = i
    }
    this.render()
  }

  onClose(): void {
    this.contentEl.empty()
  }

  /** (Re)scan the project for conflicted tasks and seed default per-field choices. */
  private rebuild(): void {
    const keyOf = new Map<string, string>()
    for (const f of flattenTasks(this.project.tasks)) {
      const k = taskExt(f.task).key
      if (k) keyOf.set(f.task.id, k)
    }
    this.items = []
    for (const f of flattenTasks(this.project.tasks)) {
      const ext = taskExt(f.task)
      if (ext.reconciled !== false || !ext.conflict) continue
      const mine = shadowOf(f.task, keyOf, localParentKey(this.project, f.task.id))
      const theirs = ext.conflict.theirs
      const fields = conflictFields(mine, ext.shadow, theirs)
      if (!fields.length) continue // stale flag (no diffs) — self-heals on the next sync
      // Fields only Jira changed (mine == base → defaultTakeTheirs) merge in silently; the
      // rest are genuine conflicts (both sides moved, or a match with no base) the user picks.
      const autoTheirs = fields.filter((d) => d.defaultTakeTheirs).map((d) => d.field)
      const decisions = fields.filter((d) => !d.defaultTakeTheirs).map((d) => d.field)
      if (!decisions.length) continue // only Jira-side changes — nothing to review here
      this.items.push({ task: f.task, mine, base: ext.shadow, theirs, decisions, autoTheirs })
      if (!this.choices.has(f.task.id)) {
        const m = new Map<SyncField, boolean>()
        for (const field of decisions) m.set(field, false) // default: keep ours (we changed it)
        this.choices.set(f.task.id, m)
      }
    }
    if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1)
  }

  private render(): void {
    const el = this.contentEl
    el.empty()
    el.createEl('h2', { text: 'Resolve Jira conflicts', cls: 'pm-modal-heading' })

    if (!this.items.length) {
      el.createDiv('pm-modal-hint').setText('All conflicts resolved. ✓')
      const f = el.createDiv('pm-modal-footer')
      new ButtonComponent(f)
        .setButtonText('Close')
        .setCta()
        .onClick(() => this.close())
      return
    }

    const body = el.createDiv('pm-jira-merge-body')
    this.renderSidebar(body.createDiv('pm-jira-merge-sidebar'))
    this.renderDetail(body.createDiv('pm-jira-merge-detail'))
  }

  private renderSidebar(side: HTMLElement): void {
    side.createDiv('pm-jira-merge-sidebar-head').setText(`${this.items.length} conflicted`)
    this.items.forEach((it, i) => {
      const row = side.createDiv('pm-jira-merge-task')
      row.toggleClass('is-active', i === this.selected)
      row.createDiv({ text: it.task.title || '(untitled)', cls: 'pm-jira-merge-task-title' })
      const key = taskExt(it.task).key ?? ''
      row.createDiv({ text: `${key} · ${it.decisions.length} field(s)`, cls: 'pm-jira-merge-task-sub' })
      row.addEventListener('click', () => {
        this.selected = i
        this.render()
      })
    })
  }

  private renderDetail(detail: HTMLElement): void {
    const it = this.items[this.selected]
    const choice = this.choices.get(it.task.id)
    if (!it || !choice) return

    const head = detail.createDiv('pm-jira-merge-detail-head')
    head.createDiv({ text: it.task.title || '(untitled)', cls: 'pm-jira-merge-detail-title' })
    const bulk = head.createDiv('pm-jira-merge-bulk')
    new ButtonComponent(bulk).setButtonText('Use all Obsidian').onClick(() => this.setAll(it, false))
    new ButtonComponent(bulk).setButtonText('Use all Jira').onClick(() => this.setAll(it, true))

    const table = detail.createDiv('pm-jira-merge-table')
    const colHead = table.createDiv('pm-jira-merge-row pm-jira-merge-colhead')
    colHead.createSpan({ text: 'Field' })
    colHead.createSpan({ text: 'Obsidian' })
    colHead.createSpan({ text: 'Base (last synced)' })
    colHead.createSpan({ text: 'Jira' })

    for (const field of it.decisions) {
      const takeTheirs = choice.get(field) ?? false
      const row = table.createDiv('pm-jira-merge-row')
      const label = row.createSpan({ text: FIELD_LABEL[field], cls: 'pm-jira-merge-field' })
      // A row can only show a description's first line, which is rarely enough to choose
      // by — so long text gets a way to see both versions in full.
      if (field === 'description') {
        const open = label.createEl('button', { text: 'compare', cls: 'pm-jira-merge-compare' })
        open.addEventListener('click', (e) => {
          e.stopPropagation()
          new JiraTextCompareModal(this.app, {
            title: `${FIELD_LABEL[field]} — ${it.task.title || '(untitled)'}`,
            mine: it.mine.description,
            theirs: it.theirs.description,
            takeTheirs: choice.get(field) ?? false,
            sourcePath: it.task.filePath ?? '',
            onPick: (take) => {
              choice.set(field, take)
              this.render()
            }
          }).open()
        })
      }

      this.sideCell(row, formatField(this.settings(), field, it.mine), !takeTheirs, 'mine', () => {
        choice.set(field, false)
        this.render()
      })
      // Base is the read-only common ancestor (no choice).
      const baseCell = row.createDiv('pm-jira-merge-cell is-base')
      baseCell.setText(it.base ? formatField(this.settings(), field, it.base) : '—')
      this.sideCell(row, formatField(this.settings(), field, it.theirs), takeTheirs, 'theirs', () => {
        choice.set(field, true)
        this.render()
      })
    }

    const footer = detail.createDiv('pm-modal-footer')
    footer.createDiv('pm-footer-spacer')
    new ButtonComponent(footer).setButtonText('Close').onClick(() => this.close())
    new ButtonComponent(footer)
      .setButtonText(this.items.length > 1 ? 'Resolve & next' : 'Resolve')
      .setCta()
      .onClick(safeAsync(() => this.resolveCurrent()))
  }

  private sideCell(
    row: HTMLElement,
    text: string,
    chosen: boolean,
    which: 'mine' | 'theirs',
    onPick: () => void
  ): void {
    const cell = row.createDiv(`pm-jira-merge-cell pm-jira-merge-${which}`)
    cell.toggleClass('is-chosen', chosen)
    const btn = cell.createEl('button', { cls: 'pm-jira-merge-pick' })
    btn.createSpan({ text: chosen ? '● ' : '○ ', cls: 'pm-jira-merge-radio' })
    btn.createSpan({ text })
    btn.addEventListener('click', onPick)
  }

  private setAll(it: MergeItem, takeTheirs: boolean): void {
    const choice = this.choices.get(it.task.id)
    if (!choice) return
    for (const field of it.decisions) choice.set(field, takeTheirs)
    this.render()
  }

  private async resolveCurrent(): Promise<void> {
    const it = this.items[this.selected]
    const choice = this.choices.get(it.task.id)
    if (!it || !choice) return
    // Take Jira for the silently-adopted (Jira-only) fields plus any decision set to Jira.
    const takeTheirs = [...it.autoTheirs, ...it.decisions.filter((f) => choice.get(f))]
    await resolveConflict(this.plugin, this.project, it.task, takeTheirs)
    this.choices.delete(it.task.id)
    await this.onDone()
    this.rebuild()
    this.render()
  }

  private settings(): { statuses: { id: string; label: string }[]; priorities: { id: string; label: string }[] } {
    return this.plugin.settings
  }
}
