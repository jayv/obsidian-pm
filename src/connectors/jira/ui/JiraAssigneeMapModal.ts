/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { App, Modal, Notice } from 'obsidian'
import type PMPlugin from '../../../main'
import { JiraClient } from '../JiraClient'
import { ensureMockServer, mockBaseUrl } from '../JiraMockServer'
import { renameAcrossProjects } from '../sync'
import { assigneeMapFor, getToken, type JiraAssignee, type JiraServer } from '../types'
import { attachUserSuggest, type JiraUser } from './userSuggest'

/**
 * The name → Jira user mapping for one server, as two aligned columns.
 *
 * This lists *only* people who are mapped. It is not a roster: a project can have team
 * members who exist purely locally, on tasks that were never synced, and those have no
 * business here — so nothing is flagged as "unmapped".
 *
 * The mapping is per server and shared by every project on it, which is why it lives in
 * settings rather than in a project. The project panel shows the same data.
 */
export class JiraAssigneeMapModal extends Modal {
  private filter = ''

  constructor(
    app: App,
    private plugin: PMPlugin,
    private server: JiraServer
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('pm-modal', 'pm-modal--jira-assignees')
    this.render()
  }

  /** A client for this server alone — no project involved, unlike the sync path. */
  private async search(query: string): Promise<JiraUser[]> {
    await ensureMockServer(this.plugin, 'MOCK')
    return new JiraClient({
      site: this.server.site,
      email: this.server.email,
      token: getToken(this.plugin, this.server.id),
      baseUrl: mockBaseUrl(this.server.site) ?? undefined
    }).userPicker(query)
  }

  private save(): void {
    void this.plugin.saveSettings()
  }

  private render(): void {
    const el = this.contentEl
    el.empty()
    el.createEl('h3', { text: `Assignee mapping · ${this.server.name || this.server.site}` })
    el.createDiv({
      cls: 'pm-modal-hint',
      text: 'Shared by every project synced with this Jira site. Only people who need syncing belong here.'
    })

    const map = assigneeMapFor(this.plugin, this.server.id)

    const filterWrap = el.createDiv('pm-jira-am-filter')
    const filterInput = filterWrap.createEl('input', { type: 'text', cls: 'pm-input', value: this.filter })
    filterInput.placeholder = 'Filter…'
    filterInput.addEventListener('input', () => {
      this.filter = filterInput.value
      const q = this.filter.trim().toLowerCase()
      for (const row of Array.from(el.querySelectorAll<HTMLElement>('.pm-jira-am-row'))) {
        row.toggleClass('pm-hidden', Boolean(q) && !(row.dataset.match ?? '').includes(q))
      }
    })

    const grid = el.createDiv('pm-jira-am-grid')
    const head = grid.createDiv('pm-jira-am-row pm-jira-am-row--head')
    head.createSpan({ text: 'Name in Obsidian' })
    head.createSpan({ text: 'User in Jira' })
    head.createSpan()

    const list = grid.createDiv('pm-jira-am-list pm-jira-am-list--tall')
    for (const entry of map) this.renderRow(list, map, entry)
    this.renderBlankRow(list, map)
  }

  private renderRow(list: HTMLElement, map: JiraAssignee[], entry: JiraAssignee): void {
    const row = list.createDiv('pm-jira-am-row')
    row.dataset.match = `${entry.name} ${entry.jiraDisplay ?? ''} ${entry.jiraUser}`.toLowerCase()

    const local = row.createEl('input', { type: 'text', cls: 'pm-input', value: entry.name })
    local.placeholder = 'Name'
    local.addEventListener('change', () => void this.renameEntry(entry, local))

    const jiraWrap = row.createDiv('pm-jira-user')
    const jira = jiraWrap.createEl('input', { type: 'text', cls: 'pm-input' })
    jira.placeholder = 'Search Jira user…'
    jira.value = entry.jiraDisplay ?? entry.jiraUser
    attachUserSuggest(jiraWrap, jira, (q) => this.search(q), {
      onPick: (u) => {
        entry.jiraUser = u.accountId
        entry.jiraDisplay = u.displayName
        jira.value = u.displayName
        this.save()
      }
    })

    const remove = row.createEl('button', { text: '✕', cls: 'pm-settings-del' })
    remove.title = 'Remove this mapping'
    remove.addEventListener('click', () => {
      map.splice(map.indexOf(entry), 1)
      this.save()
      this.render()
    })
  }

  /**
   * Renaming here is the one place a person's local name can change centrally, so it has
   * to reach the tasks: every project on this server that used the old name is updated,
   * or those tasks would point at a name nobody is on the team under.
   */
  private async renameEntry(entry: JiraAssignee, input: HTMLInputElement): Promise<void> {
    const from = entry.name
    const to = input.value.trim()
    if (!to || to === from) {
      input.value = from
      return
    }
    if (assigneeMapFor(this.plugin, this.server.id).some((e) => e !== entry && e.name === to)) {
      new Notice(`"${to}" is already mapped.`)
      input.value = from
      return
    }
    entry.name = to
    this.save()
    const touched = await renameAcrossProjects(this.plugin, this.server.id, from, to)
    if (touched) new Notice(`Renamed on ${touched} project${touched === 1 ? '' : 's'}.`)
  }

  /**
   * The always-present empty row. Completing it adds the mapping and grows the list, so
   * several people can be entered without reaching for a button.
   */
  private renderBlankRow(list: HTMLElement, map: JiraAssignee[]): void {
    const row = list.createDiv('pm-jira-am-row pm-jira-am-row--new')
    const draft: JiraAssignee = { name: '', jiraUser: '' }

    const local = row.createEl('input', { type: 'text', cls: 'pm-input' })
    local.placeholder = 'Name in Obsidian'
    local.addEventListener('change', () => {
      draft.name = local.value.trim()
      commit()
    })

    const jiraWrap = row.createDiv('pm-jira-user')
    const jira = jiraWrap.createEl('input', { type: 'text', cls: 'pm-input' })
    jira.placeholder = 'Search Jira user…'
    attachUserSuggest(jiraWrap, jira, (q) => this.search(q), {
      onPick: (u) => {
        draft.jiraUser = u.accountId
        draft.jiraDisplay = u.displayName
        jira.value = u.displayName
        // Picking a Jira user with the name still blank: their Jira name is the obvious
        // default, and it's what the sync would have created anyway.
        if (!draft.name && !local.value.trim()) local.value = u.displayName
        draft.name = local.value.trim()
        commit()
      }
    })
    row.createSpan() // keeps the three-column rhythm

    const commit = (): void => {
      if (!draft.name || !draft.jiraUser) return
      if (map.some((e) => e.name.trim().toLowerCase() === draft.name.trim().toLowerCase())) {
        new Notice(`"${draft.name}" is already mapped.`)
        return
      }
      map.push({ ...draft })
      this.save()
      this.render() // re-renders with a fresh blank row at the bottom
    }
  }
}
