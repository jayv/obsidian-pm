export interface SegmentedOption<T extends string> {
  id: T
  label: string
  cls?: string
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[]
  active: T
  onChange: (id: T) => void
}

export interface SegmentedToggleOption<T extends string | number> {
  id: T
  label: string
  ariaLabel?: string
}

export interface SegmentedToggleGroupProps<T extends string | number> {
  options: SegmentedToggleOption<T>[]
  /** Initially-pressed ids. */
  selected: readonly T[]
  onToggle: (id: T) => void
}

/**
 * Multi-select sibling of SegmentedControl: joined segments that each toggle
 * independently (any number can be pressed), for cumulative choices like the
 * prev/this/next week window. Shares the `.pm-segmented` styling.
 */
export class SegmentedToggleGroup<T extends string | number> {
  el: HTMLElement
  private buttons = new Map<T, HTMLElement>()

  constructor(parentEl: HTMLElement, props: SegmentedToggleGroupProps<T>) {
    this.el = parentEl.createDiv('pm-segmented pm-segmented--joined')
    for (const opt of props.options) {
      const btn = this.el.createEl('button', { cls: 'pm-segmented-btn', text: opt.label })
      if (opt.ariaLabel) btn.setAttribute('aria-label', opt.ariaLabel)
      this.buttons.set(opt.id, btn)
      btn.addEventListener('click', () => props.onToggle(opt.id))
    }
    this.setSelected(props.selected)
  }

  /** Repaint the pressed state from the current selection. */
  setSelected(ids: readonly T[]): this {
    for (const [id, btn] of this.buttons) {
      const on = ids.includes(id)
      btn.toggleClass('pm-segmented-btn--active', on)
      btn.setAttribute('aria-pressed', String(on))
    }
    return this
  }
}

export class SegmentedControl<T extends string> {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: SegmentedControlProps<T>) {
    this.el = parentEl.createDiv('pm-segmented')
    for (const opt of props.options) {
      const btn = this.el.createEl('button', { cls: 'pm-segmented-btn', text: opt.label })
      if (opt.cls) btn.addClass(opt.cls)
      if (opt.id === props.active) btn.addClass('pm-segmented-btn--active')
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('.pm-segmented-btn').forEach((b) => b.removeClass('pm-segmented-btn--active'))
        btn.addClass('pm-segmented-btn--active')
        props.onChange(opt.id)
      })
    }
  }
}
