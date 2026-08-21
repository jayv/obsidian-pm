/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { ButtonComponent, Notice, Setting } from 'obsidian'
import type PMPlugin from '../../../main'
import { makeId } from '../../../types'
import { safeAsync } from '../../../utils'
import { JiraClient, setJiraApiDebug } from '../JiraClient'
import { deleteMock } from '../JiraMock'
import { ensureMockServer, isLocalhost, mockBaseUrl, stopMockServer } from '../JiraMockServer'
import { assigneeMapFor, getDebug, getToken, servers, setDebug, setToken, setServers } from '../types'
import { JiraAssigneeMapModal } from './JiraAssigneeMapModal'

/**
 * Where Atlassian Cloud API tokens are created. Account-scoped rather than per-site,
 * so one URL serves every server configured here.
 */
const API_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens'

/** Renders the global "Jira servers" section in the main settings tab. */
export function renderJiraGlobalSettings(containerEl: HTMLElement, plugin: PMPlugin): void {
  new Setting(containerEl).setName('Jira servers').setHeading()
  containerEl.createEl('p', {
    text: 'Configure JIRA Cloud instances. Projects reference a server by name. Read-only / dry-run.',
    cls: 'pm-settings-desc'
  })

  new Setting(containerEl)
    .setName('Debug log Jira API calls')
    .setDesc('Log every Jira API request/response to the developer console. Debugging only.')
    .addToggle((t) =>
      t.setValue(getDebug(plugin)).onChange((on) => {
        setDebug(plugin, on)
        setJiraApiDebug(on)
        void plugin.saveSettings()
      })
    )

  const list = containerEl.createDiv('pm-jira-servers')
  const render = (): void => {
    list.empty()
    const all = servers(plugin)
    all.forEach((server, i) => {
      const card = list.createDiv('pm-jira-server-card')
      const field = (label: string, value: string, ph: string, onChange: (v: string) => void, pw = false) => {
        const w = card.createDiv('pm-jira-field')
        w.createEl('label', { text: label, cls: 'pm-label' })
        const input = w.createEl('input', { type: pw ? 'password' : 'text', value, cls: 'pm-input' })
        input.placeholder = ph
        input.addEventListener('input', () => {
          onChange(input.value)
          void plugin.saveSettings()
        })
      }
      field('Name', server.name, 'Work JIRA', (v) => (server.name = v))
      field(
        'Site',
        server.site,
        'yourco.atlassian.net',
        (v) => (server.site = v.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
      )
      field('Email', server.email, 'you@yourco.com', (v) => (server.email = v))
      field(
        'API token',
        getToken(plugin, server.id),
        'Atlassian API token',
        (v) => setToken(plugin, server.id, v),
        true
      )
      // A localhost server is the in-process mock and accepts any token, so pointing at
      // Atlassian would only mislead.
      if (!isLocalhost(server.site)) {
        const hint = card.createDiv('pm-jira-field-hint')
        const link = hint.createEl('a', { text: 'Create an API token', href: API_TOKEN_URL })
        link.setAttr('target', '_blank')
        link.setAttr('rel', 'noopener')
        hint.appendText(' in your Atlassian account, then paste it above.')
      }

      const actions = card.createDiv('pm-jira-actions')
      const result = card.createDiv('pm-jira-result')
      // Mappings are per server and shared by every project on it, so this is their home;
      // the project panel shows the same list narrowed to that project's team.
      new ButtonComponent(actions)
        .setButtonText(`Assignee mapping (${assigneeMapFor(plugin, server.id).length})`)
        .onClick(() => new JiraAssigneeMapModal(plugin.app, plugin, server).open())
      new ButtonComponent(actions).setButtonText('Test connection').onClick(
        safeAsync(async () => {
          result.setText('Testing…')
          await ensureMockServer(plugin, 'MOCK')
          const r = await new JiraClient({
            site: server.site,
            email: server.email,
            token: getToken(plugin, server.id),
            baseUrl: mockBaseUrl(server.site) ?? undefined
          }).testConnection()
          result.setText(r.ok ? `✓ Connected as ${r.user ?? 'user'}` : `✗ ${r.error ?? 'Failed'}`)
          result.toggleClass('pm-jira-result--ok', r.ok)
          result.toggleClass('pm-jira-result--err', !r.ok)
        })
      )
      new ButtonComponent(actions)
        .setButtonText('Remove')
        .setWarning()
        .onClick(
          safeAsync(async () => {
            const next = servers(plugin).slice()
            next.splice(i, 1)
            setServers(plugin, next)
            setToken(plugin, server.id, '')
            // Convenience: removing a localhost server (the in-process mock) with no
            // other localhost server left tears down the mock and deletes its DB file.
            if (isLocalhost(server.site) && !next.some((s) => isLocalhost(s.site))) {
              stopMockServer()
              if (await deleteMock(plugin)) new Notice('Removed the local Jira server and its data.')
            }
            await plugin.saveSettings()
            render()
          })
        )
    })

    new ButtonComponent(list).setButtonText('+ add server').onClick(
      safeAsync(async () => {
        setServers(plugin, [...servers(plugin), { id: makeId(), name: 'New server', site: '', email: '' }])
        await plugin.saveSettings()
        render()
      })
    )
  }
  render()
}
