import { AbstractInputSuggest, type App } from 'obsidian'

/**
 * Type-ahead over a fixed list of options (team members, tasks, …) attached to a text
 * input. Obsidian draws the popover, so it looks and keys like every other suggestion
 * list in the app — arrow keys, Enter, click.
 *
 * The options are read through a callback rather than captured, so a list that changes
 * between keystrokes (e.g. names already picked being removed) stays current.
 */
export class TextSuggest<T = string> extends AbstractInputSuggest<T> {
  constructor(
    app: App,
    input: HTMLInputElement,
    private options: () => T[],
    private onPick: (value: T) => void,
    /** How an option reads, and what the query matches against. Identity for plain names. */
    private labelOf: (value: T) => string = String
  ) {
    super(app, input)
  }

  protected getSuggestions(query: string): T[] {
    const q = query.trim().toLowerCase()
    const all = this.options()
    return q ? all.filter((o) => this.labelOf(o).toLowerCase().includes(q)) : all
  }

  renderSuggestion(value: T, el: HTMLElement): void {
    el.setText(this.labelOf(value))
  }

  selectSuggestion(value: T): void {
    this.onPick(value)
    this.close()
  }
}
