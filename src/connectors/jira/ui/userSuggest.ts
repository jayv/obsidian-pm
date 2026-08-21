/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import type { JiraAssignee } from '../types'
import { upsertAssigneeMapping } from '../taskLink'

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

/**
 * One "member → Jira user" row: a text box showing the current mapping, with type-ahead.
 * Typed text is kept as a literal accountId/name until a pick replaces it, and clearing
 * the box removes the mapping.
 */
export function renderMappingInput(
  row: HTMLElement,
  assignees: JiraAssignee[],
  member: string,
  search: (query: string) => Promise<JiraUser[]>,
  onChange: () => void
): void {
  const existing = assignees.find((e) => e.name === member)
  const wrap = row.createDiv('pm-jira-user')
  const input = wrap.createEl('input', { type: 'text', cls: 'pm-input' })
  input.placeholder = 'Search Jira user…'
  input.value = existing?.jiraDisplay ?? existing?.jiraUser ?? ''

  const set = (jiraUser: string, jiraDisplay?: string): void => {
    upsertAssigneeMapping(assignees, member, jiraUser, jiraDisplay)
    onChange()
  }
  attachUserSuggest(wrap, input, search, {
    onPick: (u) => {
      set(u.accountId, u.displayName)
      input.value = u.displayName
    },
    onType: (text) => set(text)
  })
}
