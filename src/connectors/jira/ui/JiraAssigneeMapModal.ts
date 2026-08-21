/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { App, Modal, Notice } from 'obsidian'
import type PMPlugin from '../../../main'
import { addMemberFromJira } from '../taskLink'
import { JiraClient } from '../JiraClient'
import { ensureMockServer, mockBaseUrl } from '../JiraMockServer'
import type { Project } from '../../../types'
import { assigneeMapFor, getToken, projectCfg, type JiraServer } from '../types'
import { attachUserSuggest, renderMappingInput, type JiraUser } from './userSuggest'

/**
 * The assignee mapping for one Jira server, editable in one place.
 *
 * The mapping is server-wide, so with several projects on the same site it made no sense
 * to keep editing it project by project — a person is the same person everywhere. This
 * dialog is the full list; the project panel shows the same data narrowed to that
 * project's team. Both write to `assigneeMapFor(plugin, serverId)`.
 *
 * A dialog rather than an inline settings section because the list runs as long as the
 * team does, hence the filter box.
 */
export class JiraAssigneeMapModal extends Modal {
  private filter = ''
  /** Every name that could need mapping, gathered once on open. */
  private names: string[] = []
  /** Which projects a name comes from, for the row subtitle. */
  private origin = new Map<string, string[]>()
  /** Projects synced with this server — someone added here joins every one of them. */
  private linked: Project[] = []

  constructor(
    app: App,
    private plugin: PMPlugin,
    private server: JiraServer
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass('pm-modal', 'pm-modal--jira-assignees')
    await this.gatherNames()
    this.render()
  }

  /**
   * Names worth showing: everyone on a project bound to this server, the global team, and
   * anyone already mapped — the last so a mapping for someone since removed from every
   * team is still visible and removable rather than stranded in settings.
   */
  private async gatherNames(): Promise<void> {
    const names = new Set<string>(this.plugin.settings.globalTeamMembers)
    for (const e of assigneeMapFor(this.plugin, this.server.id)) {
      if (e.name) names.add(e.name)
    }
    try {
      const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
      this.linked = projects.filter((p) => projectCfg(p)?.serverId === this.server.id)
      for (const project of this.linked) {
        for (const member of project.teamMembers) {
          if (!member) continue
          names.add(member)
          this.origin.set(member, [...(this.origin.get(member) ?? []), project.title])
        }
      }
    } catch (e) {
      console.warn('[PM] Jira: could not read projects for the assignee list', e)
    }
    this.names = [...names].sort((a, b) => a.localeCompare(b))
  }

  /** A client for this server alone — no project involved, unlike the sync path. */
  private async search(query: string): Promise<JiraUser[]> {
    await ensureMockServer(this.plugin, 'MOCK')
    const client = new JiraClient({
      site: this.server.site,
      email: this.server.email,
      token: getToken(this.plugin, this.server.id),
      baseUrl: mockBaseUrl(this.server.site) ?? undefined
    })
    return client.userPicker(query)
  }

  private save(): void {
    void this.plugin.saveSettings()
  }

  /** Map a Jira user centrally, and put them on every project synced with this server. */
  private async addFromJira(user: JiraUser): Promise<void> {
    const assignees = assigneeMapFor(this.plugin, this.server.id)
    const added = addMemberFromJira([], assignees, user) // maps centrally; the [] is a throwaway team
    if (!added) return
    this.save()

    let joined = 0
    for (const project of this.linked) {
      if (project.teamMembers.some((m) => m.trim().toLowerCase() === added.name.toLowerCase())) continue
      project.teamMembers.push(added.name)
      await this.plugin.store.saveProject(project)
      joined++
      this.origin.set(added.name, [...(this.origin.get(added.name) ?? []), project.title])
    }
    new Notice(joined ? `${added.name} added to ${joined} project${joined === 1 ? '' : 's'}.` : `Mapped ${added.name}.`)
    if (!this.names.includes(added.name)) this.names = [...this.names, added.name].sort((a, b) => a.localeCompare(b))
    this.plugin.refreshProjectViews()
    this.render()
  }

  private render(): void {
    const el = this.contentEl
    el.empty()
    el.createEl('h3', { text: `Assignee mapping · ${this.server.name || this.server.site}` })
    el.createDiv({
      cls: 'pm-modal-hint',
      text: 'Shared by every project synced with this Jira site. Unmapped people can’t have their assignment synced.'
    })

    const assignees = assigneeMapFor(this.plugin, this.server.id)
    const isMapped = (name: string): boolean => {
      const e = assignees.find((x) => x.name === name)
      return Boolean(e?.jiraUser && e.jiraUser.trim())
    }

    const unmapped = this.names.filter((n) => !isMapped(n)).length
    if (unmapped) {
      el.createDiv({
        cls: 'pm-jira-am-summary',
        text: `⚠ ${unmapped} of ${this.names.length} not mapped to a Jira user`
      })
    }

    // The list is as long as the team, so let it be narrowed.
    const filterWrap = el.createDiv('pm-jira-am-filter')
    const filterInput = filterWrap.createEl('input', { type: 'text', cls: 'pm-input', value: this.filter })
    filterInput.placeholder = 'Filter people…'
    filterInput.addEventListener('input', () => {
      this.filter = filterInput.value
      const q = this.filter.trim().toLowerCase()
      for (const row of Array.from(el.querySelectorAll<HTMLElement>('.pm-jira-am-row'))) {
        row.toggleClass('pm-hidden', Boolean(q) && !(row.dataset.name ?? '').toLowerCase().includes(q))
      }
    })

    const list = el.createDiv('pm-jira-am-list pm-jira-am-list--tall')
    if (!this.names.length) {
      list.createDiv({ cls: 'pm-modal-hint', text: 'No team members yet on projects synced with this site.' })
    }
    for (const name of this.names) {
      const row = list.createDiv('pm-jira-am-row')
      row.dataset.name = name
      const label = row.createDiv('pm-jira-am-label')
      label.createSpan({ text: name, cls: 'pm-jira-am-name' })
      const from = this.origin.get(name)
      if (from?.length) {
        label.createSpan({ text: [...new Set(from)].join(', '), cls: 'pm-jira-am-origin' })
      }
      const badge = row.createSpan({ text: 'Not mapped', cls: 'pm-jira-am-unmapped' })
      badge.toggleClass('pm-hidden', isMapped(name))
      renderMappingInput(
        row,
        assignees,
        name,
        (q) => this.search(q),
        () => {
          badge.toggleClass('pm-hidden', isMapped(name))
          this.save()
        }
      )
    }

    // Someone in Jira who isn't on any project team yet. The mapping is central, but the
    // team lists aren't — assignment, avatars and filters all read project.teamMembers —
    // so they're added to every project on this server, which is what makes them
    // assignable there.
    const addWrap = el.createDiv('pm-jira-add-member')
    const addInput = addWrap.createEl('input', { type: 'text', cls: 'pm-input' })
    addInput.placeholder = '+ add someone from Jira…'
    attachUserSuggest(addWrap, addInput, (q) => this.search(q), {
      onPick: (u) => void this.addFromJira(u)
    })
  }
}
