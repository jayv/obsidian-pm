import { AbstractInputSuggest, type App } from 'obsidian'

/**
 * Type-ahead over a fixed list of strings (team members, tags, …) attached to a text
 * input. Obsidian draws the popover, so it looks and keys like every other suggestion
 * list in the app — arrow keys, Enter, click.
 *
 * The options are read through a callback rather than captured, so a list that changes
 * between keystrokes (e.g. names already picked being removed) stays current.
 */
export class TextSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    input: HTMLInputElement,
    private options: () => string[],
    private onPick: (value: string) => void
  ) {
    super(app, input)
  }

  protected getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase()
    const all = this.options()
    return q ? all.filter((o) => o.toLowerCase().includes(q)) : all
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value)
  }

  selectSuggestion(value: string): void {
    this.onPick(value)
    this.close()
  }
}
