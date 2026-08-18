import { Notice } from 'obsidian'
import { ProgressBar } from '../../../ui/primitives/ProgressBar'

/**
 * A live progress popup for a running sync. Obsidian renders notices in the top-right
 * corner, so a sticky one (timeout 0) is the natural home: a phase line plus a bar that
 * fills while stepping through tasks, and is hidden as soon as the sync settles.
 *
 * A sync is many small HTTP round-trips, so without this a slow instance just looks
 * frozen — this also shows WHICH phase is the slow one.
 */
export class SyncProgress {
  private notice: Notice
  private phaseEl: HTMLElement
  private bar: ProgressBar
  private barWrap: HTMLElement

  constructor(title = 'Jira sync') {
    this.notice = new Notice('', 0) // 0 = stays until hide()
    // `messageEl` is the modern accessor but needs 1.8.7; manifest minAppVersion is
    // 1.7.2, so use the deprecated (still present) `noticeEl` until that floor moves.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
    const el = this.notice.noticeEl
    el.empty()
    el.addClass('pm-jira-progress')
    el.createDiv({ cls: 'pm-jira-progress-title', text: title })
    this.phaseEl = el.createDiv({ cls: 'pm-jira-progress-phase', text: 'Starting…' })
    this.barWrap = el.createDiv('pm-jira-progress-bar')
    this.bar = new ProgressBar(this.barWrap).setSize('sm')
    this.barWrap.hide()
  }

  /** Indeterminate when `total` is absent; otherwise a filling bar with a count. */
  update(phase: string, done?: number, total?: number): void {
    if (total === undefined || total <= 0) {
      this.phaseEl.setText(phase)
      this.barWrap.hide()
      return
    }
    this.phaseEl.setText(`${phase} — ${Math.min(done ?? 0, total)}/${total}`)
    this.barWrap.show()
    this.bar.setValue(((done ?? 0) / total) * 100)
  }

  hide(): void {
    this.notice.hide()
  }
}
