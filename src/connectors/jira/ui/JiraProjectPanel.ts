/* eslint-disable obsidianmd/ui/sentence-case -- "Jira" is a product name */
import { ButtonComponent, Notice, TFile } from 'obsidian'
import type PMPlugin from '../../../main'
import type { Project } from '../../../types'
import { flattenTasks } from '../../../store/TaskTreeOps'
import { confirmDialog } from '../../../ui/ModalFactory'
import { safeAsync } from '../../../utils'
import { isLocalhost } from '../JiraMockServer'
import { cleanJira, diagnoseAccess, loadMappingValues, searchJiraUsers } from '../sync'
import { setOutbound, stripJira, upsertAssigneeMapping } from '../taskLink'
import { JiraImportModal } from './JiraImportModal'
import { JiraExportModal } from './JiraExportModal'
import type { JiraProjectConfig, JiraValueMap } from '../types'
import {
  clearProjectCfg,
  ensureProjectCfg,
  getToken,
  projectCfg,
  serverById,
  servers,
  taskExt,
  validateValueMap
} from '../types'

/** Renders the per-project JIRA panel in the project modal (operates on the modal copy). */
export function renderJiraProjectPanel(
  container: HTMLElement,
  plugin: PMPlugin,
  project: Project,
  onClose: () => void,
  onChange?: () => void
): void {
  container.empty()
  // Re-render this panel, or the whole modal when the host gave us onChange (so
  // shared fields like the team-members list refresh too).
  const rerender = (): void =>
    onChange ? onChange() : renderJiraProjectPanel(container, plugin, project, onClose, onChange)
  const section = container.createDiv('pm-modal-section')
  const header = section.createDiv('pm-modal-section-header')
  header.createSpan({ text: 'Jira integration', cls: 'pm-modal-subheading' })
  header.createSpan({ text: 'Optional · two-way sync with a Jira epic', cls: 'pm-modal-hint' })

  const enableRow = section.createDiv('pm-jira-enable')
  const enable = enableRow.createEl('input', { type: 'checkbox' })
  enable.checked = Boolean(projectCfg(project)?.enabled)
  enableRow.createEl('label', { text: 'Sync this project with Jira' })
  enable.addEventListener('change', () => {
    ensureProjectCfg(project).enabled = enable.checked
    renderJiraProjectPanel(container, plugin, project, onClose, onChange)
  })

  if (!projectCfg(project)?.enabled) return
  const cfg = ensureProjectCfg(project)

  // Fetch JIRA statuses + priorities and prefill the maps, then re-render.
  const loadAndRefresh = async (): Promise<void> => {
    if (!cfg.serverId) return
    // A localhost server uses the in-process mock and needs no token.
    const site = serverById(plugin, cfg.serverId)?.site ?? ''
    const local = isLocalhost(site)
    if (!getToken(plugin, cfg.serverId) && !local) {
      new Notice('Add an API token for this server in Settings → Jira servers.')
      return
    }
    try {
      const { statusesAdded, prioritiesAdded, membersAdded } = await loadMappingValues(plugin, project)
      const epicHint = cfg.epicId ? '' : ' (set an epic key to load the shared config)'
      new Notice(
        `Jira: loaded project settings — +${statusesAdded} status, +${prioritiesAdded} priority, +${membersAdded} member(s)${epicHint}.`
      )
      rerender()
    } catch (e) {
      new Notice('Failed to load project settings from Jira. Check the console.')
      console.error('JiraProjectPanel: loadMappingValues failed', e)
    }
  }

  // Server reference. Selecting a server pulls its statuses + priorities.
  const all = servers(plugin)
  const serverWrap = section.createDiv('pm-jira-field')
  serverWrap.createEl('label', { text: 'Server', cls: 'pm-label' })
  if (!all.length) {
    serverWrap.createEl('div', { text: 'Add a server in Settings → Jira servers first.', cls: 'pm-modal-hint' })
  } else {
    const sel = serverWrap.createEl('select', { cls: 'pm-input pm-select' })
    sel.createEl('option', { value: '', text: '— select —' })
    for (const s of all) {
      const o = sel.createEl('option', { value: s.id, text: s.name || s.site })
      if (cfg.serverId === s.id) o.selected = true
    }
    sel.addEventListener(
      'change',
      safeAsync(async () => {
        cfg.serverId = sel.value
        await loadAndRefresh()
      })
    )
  }

  // Epic.
  const epicWrap = section.createDiv('pm-jira-field')
  epicWrap.createEl('label', { text: 'Epic key', cls: 'pm-label' })
  const epic = epicWrap.createEl('input', { type: 'text', value: cfg.epicId, cls: 'pm-input' })
  epic.placeholder = 'DEMO-1234'
  epic.addEventListener('input', () => {
    const next = epic.value.trim()
    if (next === cfg.epicId) return
    cfg.epicId = next
    // Re-rooting points at a different subtree, so the watermark from the old one would
    // hide every issue there that hasn't changed since. Clear it: the next sync crawls
    // the new root in full.
    cfg.lastSeenUpdated = ''
  })

  // Value maps. The button (re)loads JIRA values into them — useful after an
  // epic is set, since statuses are project-scoped.
  const statuses = plugin.settings.statuses.map((s) => ({ id: s.id, label: s.label }))
  const priorities = plugin.settings.priorities.map((p) => ({ id: p.id, label: p.label }))
  const loadRow = section.createDiv('pm-jira-field')
  new ButtonComponent(loadRow).setButtonText('Load project settings').onClick(safeAsync(loadAndRefresh))
  // Editing the maps marks them dirty so the next sync publishes them to the epic.
  const markDirty = (): void => {
    cfg.mappingsDirty = true
  }
  renderValueMap(section, 'Status map (Jira status → your status)', cfg.statusMap, statuses, markDirty, 'status')
  renderValueMap(
    section,
    'Priority map (Jira priority → your priority)',
    cfg.priorityMap,
    priorities,
    markDirty,
    'priority'
  )

  // Assignee map: one fixed row per project team member (from the list above),
  // each with a JIRA user picker. Mirrors the team list — no add/remove here.
  const amWrap = section.createDiv('pm-jira-assignees')
  amWrap.createEl('label', { text: 'Assignee map (team member → JIRA user)', cls: 'pm-label' })
  const isMapped = (member: string): boolean => {
    const e = cfg.assigneeMap.find((x) => x.name === member)
    return Boolean(e?.jiraUser && e.jiraUser.trim())
  }
  if (!project.teamMembers.length) {
    amWrap.createDiv('pm-modal-hint').setText('Add team members above to map them to Jira users.')
  } else {
    // A member with no Jira-user mapping can't have their assignment synced, so flag
    // them up front (and per row) rather than letting it surface later as a conflict.
    const summary = amWrap.createDiv('pm-jira-am-summary')
    const updateSummary = (): void => {
      const unmapped = project.teamMembers.filter((m) => m && !isMapped(m)).length
      summary.toggleClass('pm-hidden', unmapped === 0)
      summary.setText(`⚠ ${unmapped} of ${project.teamMembers.length} not mapped to a Jira user`)
    }
    const amList = amWrap.createDiv('pm-jira-am-list')
    for (const member of project.teamMembers) {
      const row = amList.createDiv('pm-jira-am-row')
      row.createSpan({ text: member, cls: 'pm-jira-am-name' })
      // Badge sits BEFORE the picker so the input stays right-aligned with every other row.
      const badge = row.createSpan({ text: 'Not mapped', cls: 'pm-jira-am-unmapped' })
      const refreshBadge = (): void => badge.toggleClass('pm-hidden', isMapped(member))
      renderUserPicker(row, plugin, project, cfg, member, () => {
        markDirty()
        refreshBadge()
        updateSummary()
      })
      refreshBadge()
    }
    updateSummary()
  }

  // Sync interval.
  const intervalWrap = section.createDiv('pm-jira-field')
  intervalWrap.createEl('label', { text: 'Sync interval (minutes)', cls: 'pm-label' })
  const intervalIn = intervalWrap.createEl('input', {
    type: 'number',
    value: String(cfg.syncIntervalMin ?? 5),
    cls: 'pm-input'
  })
  intervalIn.addEventListener('input', () => {
    const n = parseInt(intervalIn.value, 10)
    cfg.syncIntervalMin = Number.isFinite(n) && n > 0 ? n : 5
  })

  // Import / export / disconnect actions. Import & export operate on this same
  // project object, so their writes persist alongside the modal's own save.
  const danger = section.createDiv('pm-jira-danger')
  // After import/export, refresh views AND re-render this panel so newly created
  // team members / assignee mappings show up immediately.
  const refresh = (): void => {
    plugin.refreshProjectViews()
    rerender()
  }
  new ButtonComponent(danger)
    .setButtonText('Jira import')
    .onClick(() => new JiraImportModal(plugin.app, plugin, project, refresh).open())
  new ButtonComponent(danger)
    .setButtonText('Jira export')
    .onClick(() => new JiraExportModal(plugin.app, plugin, project, refresh).open())
  // Read-only probe: what can this token actually do on the mapped project? Creates
  // nothing — the quickest answer when syncs fail with a permission error.
  new ButtonComponent(danger).setButtonText('Check access').onClick(
    safeAsync(async () => {
      const d = await diagnoseAccess(plugin, project)
      if (!d) {
        new Notice('Jira: project is not connected.')
        return
      }
      if (d.error || !d.permissions) {
        new Notice(`Jira access check failed: ${d.error ?? 'could not read permissions.'}`)
        console.warn('[PM] Jira access check', d)
        return
      }
      const missing = Object.entries(d.permissions)
        .filter(([, granted]) => !granted)
        .map(([name]) => name)
      console.debug(`[PM] Jira access for ${d.user ?? 'token'} on ${d.projectKey}`, d.permissions)
      new Notice(
        missing.length
          ? `Jira (${d.projectKey}) as ${d.user ?? 'token'} — missing: ${missing.join(', ')}. See the console.`
          : `Jira (${d.projectKey}) as ${d.user ?? 'token'} — all sync permissions granted.`
      )
    })
  )
  new ButtonComponent(danger)
    .setButtonText('Clean Jira')
    .setWarning()
    .onClick(
      safeAsync(async () => {
        const ok = await confirmDialog(
          plugin.app,
          'Clean Jira? Deletes all plugin metadata (the obsidian-pm properties) from every linked issue and the epic on the Jira side, then fully disconnects this project locally for a clean reset. The Jira issues themselves are kept. This cannot be undone.'
        )
        if (!ok) return
        // Operate on the freshly-loaded project (not the modal's clone) so the wipe lands
        // on disk and the views refresh from clean state — the modal copy is discarded on close.
        const file = plugin.app.vault.getAbstractFileByPath(project.filePath)
        const real = file instanceof TFile ? await plugin.store.loadProject(file) : null
        if (!real) {
          new Notice('Jira: could not load the project to clean.')
          return
        }
        const res = await cleanJira(plugin, real)
        if (!res) {
          new Notice('Jira: project is not connected.')
          return
        }
        if (res.failed) {
          // Remote wipe incomplete → local state is left intact so the user can retry.
          new Notice(`Jira: ${res.failed} metadata delete(s) failed — still connected, please retry.`)
          plugin.refreshProjectViews()
          return
        }
        new Notice(
          `Jira cleaned: wiped ${res.cleaned} issue(s)${res.epic ? ' + epic config' : ''}; project disconnected.`
        )
        plugin.refreshProjectViews()
        onClose()
      })
    )
  new ButtonComponent(danger)
    .setButtonText('Disconnect from Jira')
    .setWarning()
    .onClick(
      safeAsync(async () => {
        const ok = await confirmDialog(
          plugin.app,
          'Disconnect this project from Jira? Clears the Jira config and removes the Jira link from every task (the tasks stay).'
        )
        if (!ok) return
        const file = plugin.app.vault.getAbstractFileByPath(project.filePath)
        const real = file instanceof TFile ? await plugin.store.loadProject(file) : null
        if (real) {
          clearProjectCfg(real)
          const ids = flattenTasks(real.tasks)
            .filter((f) => taskExt(f.task).key || taskExt(f.task).sync)
            .map((f) => f.task.id)
          await plugin.store.updateTasks(real, ids, (t) => ({ ext: stripJira(t.ext) }))
          plugin.refreshProjectViews()
        }
        onClose()
      })
    )
}

/**
 * A text input with JIRA user autocomplete for one team member. Upserts the
 * member's entry in the assignee map by name, storing the accountId + display
 * name on pick (and pruning the entry when cleared).
 */
function renderUserPicker(
  row: HTMLElement,
  plugin: PMPlugin,
  project: Project,
  cfg: JiraProjectConfig,
  member: string,
  markDirty: () => void
): void {
  const existing = cfg.assigneeMap.find((e) => e.name === member)
  const wrap = row.createDiv('pm-jira-user')
  const input = wrap.createEl('input', { type: 'text', cls: 'pm-input' })
  input.placeholder = 'Search Jira user…'
  input.value = existing?.jiraDisplay ?? existing?.jiraUser ?? ''
  const suggest = wrap.createDiv('pm-jira-suggest')
  suggest.hide()

  const setMapping = (jiraUser: string, jiraDisplay?: string): void => {
    upsertAssigneeMapping(cfg.assigneeMap, member, jiraUser, jiraDisplay)
    markDirty()
  }

  const close = (): void => {
    suggest.empty()
    suggest.hide()
  }
  const search = async (q: string): Promise<void> => {
    const users = await searchJiraUsers(plugin, project, q)
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
        setMapping(u.accountId, u.displayName)
        input.value = u.displayName
        close()
      })
    }
    suggest.show()
  }

  let timer = 0
  input.addEventListener('input', () => {
    // Manual text is kept as a literal accountId/name until a pick overrides it.
    setMapping(input.value)
    window.clearTimeout(timer)
    const q = input.value
    timer = window.setTimeout(() => void search(q), 250)
  })
  input.addEventListener('blur', () => window.setTimeout(close, 150))
}

/**
 * Editor for a string-match value map (status or priority). Many JIRA values can
 * map to one of ours; the "push" radio marks the single value sent back to JIRA
 * for that target (exclusive per target).
 */
function renderValueMap(
  parent: HTMLElement,
  label: string,
  entries: JiraValueMap[],
  targets: { id: string; label: string }[],
  markDirty: () => void,
  kind: string
): void {
  const wrap = parent.createDiv('pm-jira-map')
  wrap.createEl('label', { text: label, cls: 'pm-label' })
  const listEl = wrap.createDiv('pm-jira-map-list')
  const errEl = wrap.createDiv('pm-jira-map-errors')
  const render = (): void => {
    listEl.empty()
    // Counts for inline highlighting of invalid rows.
    const jiraCounts = new Map<string, number>()
    const outboundCounts = new Map<string, number>()
    for (const e of entries) {
      const k = e.jira.trim().toLowerCase()
      if (k) jiraCounts.set(k, (jiraCounts.get(k) ?? 0) + 1)
      if (e.outbound) outboundCounts.set(e.target, (outboundCounts.get(e.target) ?? 0) + 1)
    }
    entries.forEach((e, i) => {
      const row = listEl.createDiv('pm-jira-map-row')
      const val = row.createEl('input', { type: 'text', value: e.jira, cls: 'pm-input' })
      val.placeholder = 'Jira value, e.g. In Progress'
      if ((jiraCounts.get(e.jira.trim().toLowerCase()) ?? 0) > 1) val.addClass('pm-jira-invalid')
      val.addEventListener('input', () => {
        e.jira = val.value
        markDirty()
        render()
      })
      const sel = row.createEl('select', { cls: 'pm-input pm-select' })
      for (const t of targets) {
        const o = sel.createEl('option', { value: t.id, text: t.label })
        if (e.target === t.id) o.selected = true
      }
      sel.addEventListener('change', () => {
        e.target = sel.value
        markDirty()
        render()
      })
      // Outbound canonical: one per target. Enabling clears siblings sharing the target.
      const pushWrap = row.createEl('label', { cls: 'pm-jira-push' })
      const push = pushWrap.createEl('input', { type: 'checkbox' })
      push.checked = Boolean(e.outbound)
      push.title = 'Push this Jira value when syncing this status/priority out to Jira'
      if (e.outbound && (outboundCounts.get(e.target) ?? 0) > 1) push.addClass('pm-jira-invalid')
      pushWrap.createSpan({ text: '→ Jira' })
      push.addEventListener('change', () => {
        if (push.checked) setOutbound(entries, e)
        else e.outbound = false
        markDirty()
        render()
      })
      const rm = row.createEl('button', { text: '✕', cls: 'pm-settings-del' })
      rm.addEventListener('click', () => {
        entries.splice(i, 1)
        markDirty()
        render()
      })
    })
    const add = listEl.createEl('button', { text: '+ add rule', cls: 'pm-prop-add-btn' })
    add.addEventListener('click', () => {
      entries.push({ jira: '', target: targets[0]?.id ?? '' })
      markDirty()
      render()
    })
    // Validation: surface duplicate JIRA values / multiple write-back rules.
    errEl.empty()
    for (const msg of validateValueMap(entries, kind, targets)) {
      errEl.createDiv({ text: `⚠ ${msg}`, cls: 'pm-jira-map-error' })
    }
  }
  render()
}
