import type PMPlugin from '../../main'
import type { Project, Task } from '../../types'

export const JIRA_ID = 'jira'

/**
 * One mapping rule between a JIRA status/priority name and one of ours. Matching
 * is a simple case-insensitive string compare. Many JIRA values can map to one
 * of ours (N→1); `outbound` marks the single value to push back when syncing
 * that target out to JIRA.
 */
export interface JiraValueMap {
  jira: string
  target: string
  outbound?: boolean
  /**
   * The JIRA-side id for this value (priority id / status id), discovered once at
   * mapping-load and persisted here so outbound writes/matches use the id, not the
   * display name (robust against renames + duplicate names). Absent on legacy maps —
   * writes fall back to the name when it's missing.
   */
  id?: string
}

/** A team-member ↔ JIRA user mapping row. */
export interface JiraAssignee {
  jiraUser: string
  name: string
  jiraDisplay?: string
}

/** A configured JIRA Cloud instance (global, in main settings). Token is a secret. */
export interface JiraServer {
  id: string
  name: string
  site: string // e.g. yourco.atlassian.net
  email: string
}

/** Per-project JIRA config, stored in project.ext.jira. */
export interface JiraProjectConfig {
  enabled: boolean
  serverId: string
  epicId: string
  statusMap: JiraValueMap[] // JIRA status name → our status id (N→1, one outbound)
  priorityMap: JiraValueMap[] // JIRA priority name → our priority (N→1, one outbound)
  assigneeMap: JiraAssignee[]
  ignoredKeys: string[]
  dirtyQueue: string[]
  /** Local maps changed since last push to the epic config property. */
  mappingsDirty?: boolean
  syncIntervalMin?: number
  lastSyncAt?: string
  lastSeenUpdated?: string
}

/**
 * The last values we synced with JIRA for a task (the merge baseline). Outbound
 * pushes send ONLY fields that differ from this shadow, so an unrelated local edit
 * never clobbers a field a teammate changed in JIRA. Updated on every push/pull.
 */
export interface JiraShadow {
  title: string
  status: string
  priority: string
  start: string
  due: string
  assignees: string[]
  milestone: boolean
  /** The note's body, as Markdown. Jira stores it as an ADF tree; see adf.ts. */
  description: string
  /** JIRA keys this task is "blocked by" (dependencies), for the link 3-way merge. */
  blockedBy: string[]
}

/** A captured conflict: the JIRA side at detection time, for the per-field resolve UI. */
export interface JiraConflict {
  /** The JIRA snapshot when the conflict was detected (their values per synced field). */
  theirs: JiraShadow
}

/** Per-task JIRA link, stored in task.ext.jira. */
export interface JiraTaskExt {
  key?: string
  sync?: boolean
  /** false when local fields and JIRA's diverge and couldn't auto-merge (in conflict). */
  reconciled?: boolean
  /** The JIRA snapshot captured when a conflict was flagged; drives the per-field resolve UI. */
  conflict?: JiraConflict
  /** Last-synced field values; the baseline for field-level outbound diffing. */
  shadow?: JiraShadow
  /**
   * Jira description nodes Markdown can't hold — an expand block, a macro — kept verbatim
   * and referenced from the note by token, so pushing puts the original back instead of
   * the words describing it. Attachments aren't here: their link carries its own id.
   */
  adfStash?: Record<string, unknown>
}

/**
 * Per-issue entity-property bag (`obsidian-pm`) for SHARED facts JIRA can't represent
 * natively (not per-user intent), e.g. whether the issue is a milestone.
 */
export const ISSUE_PROP = 'obsidian-pm'
export interface JiraIssueProps {
  milestone?: boolean
}

/**
 * Per-EPIC entity-property bag (`obsidian-pm-config`) holding the project's mapping
 * config, so other Obsidian users can bootstrap + import from the epic.
 */
export const CONFIG_PROP = 'obsidian-pm-config'
/**
 * Mapping config published to the root issue's entity property so other Obsidian users
 * syncing the same tree inherit it. Deliberately status + priority only: assignee
 * mappings are name↔accountId pairs, and there's no reason to put those in Jira.
 */
export interface JiraEpicConfig {
  statusMap: JiraValueMap[]
  priorityMap: JiraValueMap[]
}

// ── Global servers + secrets (plugin settings) ───────────────────────────────
interface JiraGlobalSettings {
  servers?: JiraServer[]
  /**
   * Assignee mappings keyed by server id. Held per server rather than per project: an
   * accountId only means anything on the site it came from, but within a site a person is
   * the same person on every project, so mapping them once is enough.
   */
  assignees?: Record<string, JiraAssignee[]>
  /** Verbose mock req/resp logging to the console (debugging only). */
  debug?: boolean
}

/** The stored settings object itself (created on demand), for callers that mutate in place. */
function jiraGlobalLive(plugin: PMPlugin): JiraGlobalSettings {
  const connectors = (plugin.settings.connectors = plugin.settings.connectors ?? {})
  const existing = connectors[JIRA_ID] as JiraGlobalSettings | undefined
  const live = existing ?? {}
  connectors[JIRA_ID] = live
  return live
}
function jiraGlobal(plugin: PMPlugin): JiraGlobalSettings {
  return (plugin.settings.connectors?.[JIRA_ID] as JiraGlobalSettings | undefined) ?? {}
}
function setJiraGlobal(plugin: PMPlugin, patch: Partial<JiraGlobalSettings>): void {
  const connectors = (plugin.settings.connectors = plugin.settings.connectors ?? {})
  connectors[JIRA_ID] = { ...jiraGlobal(plugin), ...patch }
}
export function servers(plugin: PMPlugin): JiraServer[] {
  return jiraGlobal(plugin).servers ?? []
}
export function setServers(plugin: PMPlugin, list: JiraServer[]): void {
  setJiraGlobal(plugin, { servers: list })
}
export function getDebug(plugin: PMPlugin): boolean {
  return Boolean(jiraGlobal(plugin).debug)
}
export function setDebug(plugin: PMPlugin, on: boolean): void {
  setJiraGlobal(plugin, { debug: on })
}
/**
 * The live mapping list for one server. Mutate it in place, then `plugin.saveSettings()`.
 */
export function assigneeMapFor(plugin: PMPlugin, serverId: string): JiraAssignee[] {
  const global = jiraGlobalLive(plugin)
  const maps = (global.assignees = global.assignees ?? {})
  const list = (maps[serverId] = maps[serverId] ?? [])
  return list
}

/**
 * The mappings a project should use: its server's shared list.
 *
 * Any mappings still held on the project — an older vault, or a config just adopted from
 * the epic — are folded in on the way through and then dropped, so the project file stops
 * carrying its own copy and everything converges on the one list. Folding never clobbers:
 * a name already mapped centrally wins.
 */
export function sharedAssignees(plugin: PMPlugin, cfg: JiraProjectConfig): JiraAssignee[] {
  const shared = assigneeMapFor(plugin, cfg.serverId)
  if (cfg.assigneeMap.length) {
    for (const e of cfg.assigneeMap) {
      if (e.name && !shared.some((x) => x.name === e.name)) shared.push(e)
    }
    cfg.assigneeMap = []
    // Persist the moment we take ownership. The project file loses its copy on its next
    // save, so leaving the central copy unwritten would open a window where a restart
    // loses the mapping from both places.
    void plugin.saveSettings()
  }
  return shared
}

export function serverById(plugin: PMPlugin, id: string): JiraServer | undefined {
  return servers(plugin).find((s) => s.id === id)
}
export function getToken(plugin: PMPlugin, serverId: string): string {
  return plugin.settings.connectorSecrets?.[`${JIRA_ID}:${serverId}`] ?? ''
}
export function setToken(plugin: PMPlugin, serverId: string, token: string): void {
  const secrets = (plugin.settings.connectorSecrets = plugin.settings.connectorSecrets ?? {})
  if (token) secrets[`${JIRA_ID}:${serverId}`] = token
  else Reflect.deleteProperty(secrets, `${JIRA_ID}:${serverId}`)
}

// ── Per-project config (project.ext.jira) ────────────────────────────────────
export function projectCfg(project: Project): JiraProjectConfig | undefined {
  return project.ext?.[JIRA_ID] as JiraProjectConfig | undefined
}
export function ensureProjectCfg(project: Project): JiraProjectConfig {
  const ext = (project.ext = project.ext ?? {})
  let cfg = ext[JIRA_ID] as JiraProjectConfig | undefined
  if (!cfg) {
    cfg = {
      enabled: false,
      serverId: '',
      epicId: '',
      statusMap: [],
      priorityMap: [],
      assigneeMap: [],
      ignoredKeys: [],
      dirtyQueue: []
    }
    ext[JIRA_ID] = cfg
  }
  // Reset legacy regex entries ({pattern, target}) that predate the string-match
  // model — they carry no `jira` field, so drop them. (Duplicates aren't silently
  // rewritten; they're surfaced by validateValueMap so the user can fix them.)
  cfg.statusMap = sanitizeValueMap(cfg.statusMap)
  cfg.priorityMap = sanitizeValueMap(cfg.priorityMap)
  return cfg
}

/** Keep only well-formed string-match rules (drops legacy regex entries). */
export function sanitizeValueMap(entries: unknown): JiraValueMap[] {
  if (!Array.isArray(entries)) return []
  return entries.filter(
    (e): e is JiraValueMap =>
      Boolean(e) && typeof (e as JiraValueMap).jira === 'string' && typeof (e as JiraValueMap).target === 'string'
  )
}

/**
 * Validate a status/priority map against the model's invariants and return a list of
 * human-readable errors (empty = valid):
 *   - each JIRA value may appear in at most ONE rule (no two inputs for one JIRA value)
 *   - each of our targets has EXACTLY ONE outbound "→ Jira" rule: not more than one,
 *     and (when the full `targets` list is given) not zero — every Obsidian value must
 *     be writable back to JIRA.
 * Many JIRA values mapping to one target (N→1 inbound) is allowed and not flagged.
 */
export function validateValueMap(
  entries: JiraValueMap[],
  kind = 'status',
  targets: { id: string; label: string }[] = []
): string[] {
  const errors: string[] = []
  const labelOf = (id: string): string => targets.find((t) => t.id === id)?.label ?? id

  const byJira = new Map<string, { name: string; n: number }>()
  for (const e of entries) {
    const k = e.jira.trim().toLowerCase()
    if (!k) continue
    const c = byJira.get(k) ?? { name: e.jira, n: 0 }
    c.n++
    byJira.set(k, c)
  }
  for (const { name, n } of byJira.values()) {
    if (n > 1) errors.push(`Jira ${kind} "${name}" appears in ${n} rules — each Jira ${kind} may map only once.`)
  }

  const outbound = new Map<string, number>()
  for (const e of entries) if (e.outbound) outbound.set(e.target, (outbound.get(e.target) ?? 0) + 1)
  for (const [target, n] of outbound) {
    if (n > 1) errors.push(`"${labelOf(target)}" has ${n} rules flagged "→ Jira" — only one may write back.`)
  }
  // Every Obsidian value must have a write-back rule (one of its JIRA values flagged).
  for (const t of targets) {
    if (!outbound.has(t.id)) {
      errors.push(`"${t.label}" has no rule flagged "→ Jira" — Obsidian can't write this ${kind} back.`)
    }
  }
  return errors
}
export function clearProjectCfg(project: Project): void {
  if (project.ext) Reflect.deleteProperty(project.ext, JIRA_ID)
}

// ── Per-task ext (task.ext.jira) ─────────────────────────────────────────────
export function taskExt(task: Task): JiraTaskExt {
  return (task.ext?.[JIRA_ID] as JiraTaskExt) ?? {}
}
export function ensureTaskExt(task: Task): JiraTaskExt {
  const ext = (task.ext = task.ext ?? {})
  let j = ext[JIRA_ID] as JiraTaskExt | undefined
  if (!j) {
    j = {}
    ext[JIRA_ID] = j
  }
  return j
}
