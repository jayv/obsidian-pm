export interface JiraUser {
  accountId: string
  displayName: string
}

/**
 * Jira user autocomplete for `input`, with the suggestion list rendered into `wrap`.
 *
 * Takes a search function rather than a project, so the same control serves the project
 * panel (searching through that project's server) and the settings dialog (searching a
 * server directly, with no project involved).
 */
export function attachUserSuggest(
  wrap: HTMLElement,
  input: HTMLInputElement,
  search: (query: string) => Promise<JiraUser[]>,
  handlers: { onPick: (user: JiraUser) => void; onType?: (text: string) => void }
): void {
  const suggest = wrap.createDiv('pm-jira-suggest')
  suggest.hide()
  const close = (): void => {
    suggest.empty()
    suggest.hide()
  }
  const run = async (q: string): Promise<void> => {
    const users = await search(q)
    suggest.empty()
    if (!users.length) {
      close()
      return
    }
    for (const u of users) {
      const item = suggest.createDiv('pm-jira-suggest-item')
      item.createSpan({ text: u.displayName })
      item.createSpan({ text: u.accountId, cls: 'pm-jira-suggest-id' })
      // mousedown (not click) fires before the input's blur, so the pick lands.
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        handlers.onPick(u)
        close()
      })
    }
    suggest.show()
  }

  let timer = 0
  input.addEventListener('input', () => {
    handlers.onType?.(input.value)
    window.clearTimeout(timer)
    const q = input.value
    timer = window.setTimeout(() => void run(q), 250)
  })
  input.addEventListener('blur', () => window.setTimeout(close, 150))
}
