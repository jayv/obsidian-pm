import { App, ButtonComponent, Component, MarkdownRenderer, Modal } from 'obsidian'

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
      /** For resolving links and embeds while previewing. */
      sourcePath?: string
    }
  ) {
    super(app)
  }

  /** Raw by default: the question is which text to keep, and rendering hides the
   *  differences that decide it — a stray placeholder, a lost bullet, trailing space. */
  private preview = false
  private rendered = new Component()

  onClose(): void {
    this.rendered.unload()
  }

  onOpen(): void {
    this.modalEl.addClass('pm-modal', 'pm-modal--compare')
    // A fresh component per render, so a previous preview's children are cleaned up
    // rather than leaking listeners across toggles.
    this.rendered.unload()
    this.rendered = new Component()
    this.rendered.load()
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
    new ButtonComponent(footer)
      .setButtonText(this.preview ? 'Show raw text' : 'Show preview')
      .setTooltip(this.preview ? 'Compare the text as stored' : 'Compare the text as it renders')
      .onClick(() => {
        this.preview = !this.preview
        this.onOpen()
      })
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
    if (!this.preview) {
      col.createEl('pre', { cls: 'pm-compare-text', text: text || 'Empty' })
      return
    }
    const body = col.createDiv('pm-compare-text pm-compare-text--rendered')
    if (!text.trim()) body.setText('Empty')
    else void MarkdownRenderer.render(this.app, text, body, this.opts.sourcePath ?? '', this.rendered)
  }
}
