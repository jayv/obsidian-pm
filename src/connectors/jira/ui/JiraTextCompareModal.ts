import { App, ButtonComponent, Modal } from 'obsidian'

/**
 * Two versions of one long field, side by side, big enough to actually read.
 *
 * The resolver gives each field a table row, which is right for a status or a date and
 * useless for a description — a first line tells you almost nothing about which version
 * you want. This shows both in full, and lets you pick from here.
 */
export class JiraTextCompareModal extends Modal {
  constructor(
    app: App,
    private opts: {
      title: string
      mine: string
      theirs: string
      /** Marks which side the resolver currently has selected. */
      takeTheirs: boolean
      onPick: (takeTheirs: boolean) => void
    }
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('pm-modal', 'pm-modal--compare')
    const el = this.contentEl
    el.empty()
    el.createEl('h3', { text: this.opts.title })
    el.createDiv({
      cls: 'pm-modal-hint',
      text: 'The version you keep replaces the other. Line breaks and formatting are shown as stored.'
    })

    const cols = el.createDiv('pm-compare-cols')
    this.side(cols, 'Obsidian', this.opts.mine, !this.opts.takeTheirs, false)
    this.side(cols, 'Jira', this.opts.theirs, this.opts.takeTheirs, true)

    const footer = el.createDiv('pm-modal-footer')
    footer.createDiv('pm-footer-spacer')
    new ButtonComponent(footer).setButtonText('Close').onClick(() => this.close())
  }

  private side(parent: HTMLElement, label: string, text: string, active: boolean, takeTheirs: boolean): void {
    const col = parent.createDiv('pm-compare-col')
    col.toggleClass('is-active', active)
    const head = col.createDiv('pm-compare-head')
    head.createSpan({ text: label })
    new ButtonComponent(head)
      .setButtonText(active ? 'Keeping this' : 'Keep this')
      .setDisabled(active)
      .onClick(() => {
        this.opts.onPick(takeTheirs)
        this.close()
      })
    // A pre block, not rendered Markdown: which version to keep is a question about the
    // text itself, and rendering would hide exactly the differences that decide it.
    col.createEl('pre', { cls: 'pm-compare-text', text: text || '(empty)' })
  }
}
