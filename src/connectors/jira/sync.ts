import type PMPlugin from '../../main'
import type { Project, Task, TaskPriority } from '../../types'
import { makeTask } from '../../types'
import { flattenTasks } from '../../store/TaskTreeOps'
import { JiraClient } from './JiraClient'
import type { JiraIssue } from './JiraModel'
import {
  levelOfType,
  mapInbound,
  mapOutboundEntry,
  mergePriorityMap,
  mergeStatusMap,
  projectKeyOf,
  typeForLevel
} from './JiraModel'
import { SYNC_FIELDS, type SyncField, fieldsEqual, threeWay } from './reconcile'
import { markdownToAdf, unrestorablePlaceholders, type AdfStash } from './adf'
import { ensureMockBackend, mockBaseUrl } from './JiraMockServer'
import type { JiraEpicConfig, JiraIssueProps, JiraProjectConfig, JiraShadow, JiraValueMap } from './types'
import {
  CONFIG_PROP,
  ISSUE_PROP,
  JIRA_ID,
  clearProjectCfg,
  ensureTaskExt,
  getToken,
  projectCfg,
  sharedAssignees,
  serverById,
  taskExt
} from './types'
import { stripJira } from './taskLink'

/** Build a client from the project's referenced server + secret, or null. */
export function makeClient(plugin: PMPlugin, project: Project): JiraClient | null {
  const cfg = projectCfg(project)
  if (!cfg?.enabled) return null
  const server = serverById(plugin, cfg.serverId)
  if (!server?.site) return null
  // A "localhost" server routes to the in-process mock (OS-assigned port), so it
  // needs no API token; a real instance does.
  const baseUrl = mockBaseUrl(server.site) ?? undefined
  const token = getToken(plugin, cfg.serverId)
  if (!token && !baseUrl) return null
  return new JiraClient({ site: server.site, email: server.email, token, baseUrl })
}

const projectKey = (cfg: JiraProjectConfig): string => projectKeyOf(cfg.epicId) || 'MOCK'

async function ready(
  plugin: PMPlugin,
  project: Project
): Promise<{ client: JiraClient; cfg: JiraProjectConfig } | null> {
  const cfg = projectCfg(project)
  if (!cfg?.enabled) return null
  await ensureMockBackend(plugin, project, cfg) // inert unless this is the local mock
  const client = makeClient(plugin, project)
  return client ? { client, cfg } : null
}

// ── Mapping helpers ──────────────────────────────────────────────────────────

function mapPriority(issue: JiraIssue, cfg: JiraProjectConfig): TaskPriority {
  return mapInbound(cfg.priorityMap, issue.priority, 'medium') as TaskPriority
}

/** Resolve a JIRA assignee to our name; auto-create the member + mapping if unknown (marks config dirty). */
export function resolveAssignee(plugin: PMPlugin, project: Project, issue: JiraIssue): string | null {
  const cfg = projectCfg(project)
  if (!cfg) return null
  if (!issue.assigneeAccountId && !issue.assigneeName) return null
  const map = sharedAssignees(plugin, cfg)
  const found = map.find(
    (e) => e.jiraUser && (e.jiraUser === issue.assigneeAccountId || e.jiraUser === issue.assigneeName)
  )
  const name = found?.name ?? issue.assigneeName ?? issue.assigneeAccountId ?? ''
  if (!name) return null
  if (!found) {
    map.push({
      name,
      jiraUser: issue.assigneeAccountId ?? issue.assigneeName ?? name,
      jiraDisplay: issue.assigneeName ?? undefined
    })
    void plugin.saveSettings() // its only home is plugin settings — write it there now
  }
  // Always ensure the resolved assignee is a project team member — even when the
  // mapping already existed (e.g. adopted from the shared epic config on import).
  if (!project.teamMembers.includes(name)) project.teamMembers.push(name)
  return name
}

/** Whether the project currently has any unresolved JIRA sync conflicts. */
export function hasConflicts(project: Project): boolean {
  return flattenTasks(project.tasks).some((f) => taskExt(f.task).reconciled === false)
}

/**
 * The merge baseline (last-synced values) for a task's current local state. Pass
 * `keyOf` (task id → JIRA key) to capture dependencies as the JIRA keys this task is
 * "blocked by"; without it `blockedBy` is empty (callers that set it explicitly).
 */
export function shadowOf(task: Task, keyOf?: Map<string, string>): JiraShadow {
  return {
    title: task.title,
    status: task.status,
    priority: task.priority,
    start: task.start || '',
    due: task.due || '',
    assignees: [...task.assignees],
    milestone: task.type === 'milestone',
    description: task.description || '',
    blockedBy: keyOf ? desiredBlockerKeys(task, keyOf) : []
  }
}

/** True when two shadows agree on every synced field. */
function shadowEqual(a: JiraShadow, b: JiraShadow): boolean {
  return SYNC_FIELDS.every((f) => fieldsEqual(a[f], b[f], f))
}

function withJiraKey(
  task: Task,
  key: string,
  keyOf: Map<string, string>,
  cfg: JiraProjectConfig,
  startField = '',
  plugin: PMPlugin
): Record<string, unknown> {
  const shadow = shadowOf(task, keyOf)
  // Same reasoning as the assignee below: with no start field discovered the date was
  // never sent, so don't record it as synced — leave it pending instead of losing it.
  if (!startField) shadow.start = ''
  // Only record the assignee as synced when it was actually pushed. An unmapped assignee
  // isn't sent to Jira (assigneeField → undefined), so a fresh pull reports none —
  // recording the local name here would make the next reconcile read Jira's empty
  // assignee as a remote deletion and drop it. Leaving it out keeps the field "to push",
  // surfaced as a conflict until the member is mapped, never silently lost.
  if (assigneeField(plugin, task, cfg) === undefined) shadow.assignees = []
  return { ...task.ext, [JIRA_ID]: { ...taskExt(task), key, sync: true, shadow } }
}

/**
 * Flag the task as in conflict, capturing JIRA's snapshot for the per-field resolve UI.
 * Keeps local values AND the shadow unchanged, so the next sync still sees the
 * divergence (the change isn't silently dropped) until the user resolves it.
 */
function flagConflict(task: Task, theirs: JiraShadow): Record<string, unknown> {
  return { ...task.ext, [JIRA_ID]: { ...taskExt(task), reconciled: false, conflict: { theirs } } }
}

/** Ext with the shadow advanced to the merged baseline and the conflict flag cleared. */
function withMergedShadow(task: Task, shadow: JiraShadow, stash?: AdfStash): Record<string, unknown> {
  const jx: Record<string, unknown> = { ...taskExt(task), shadow }
  // Only when the merged text is Jira's: keeping a stale stash beside our own text would
  // restore nodes that text no longer references.
  if (stash) jx.adfStash = stash
  Reflect.deleteProperty(jx, 'reconciled')
  Reflect.deleteProperty(jx, 'conflict')
  return { ...task.ext, [JIRA_ID]: jx }
}

/**
 * Resolve a flagged conflict field-by-field: `takeTheirs` lists the fields to adopt
 * JIRA's value for; every other field keeps its local value. The shadow is reset to
 * JIRA's captured snapshot (the new baseline), so kept-local fields differ from it and
 * the next sync pushes them, while taken fields already match and stay put.
 */
export async function resolveConflict(
  plugin: PMPlugin,
  project: Project,
  task: Task,
  takeTheirs: SyncField[]
): Promise<void> {
  const ext = taskExt(task)
  const theirs = ext.conflict?.theirs
  if (!theirs) return
  const take = new Set(takeTheirs)
  const patch: Partial<Task> = {}
  if (take.has('title')) patch.title = theirs.title
  if (take.has('status')) patch.status = theirs.status
  if (take.has('priority')) patch.priority = theirs.priority as TaskPriority
  if (take.has('start')) patch.start = theirs.start
  if (take.has('due')) patch.due = theirs.due
  if (take.has('assignees')) patch.assignees = [...theirs.assignees]
  if (take.has('milestone')) patch.type = theirs.milestone ? 'milestone' : 'task'
  // Adopting Jira's description has to write the note's body. Missing this meant picking
  // "Jira" changed nothing locally while the shadow moved to Jira's value — so the next
  // sync saw the untouched local text as a fresh edit and pushed it back over Jira's.
  if (take.has('description')) patch.description = theirs.description
  if (take.has('blockedBy')) {
    const idOf = new Map<string, string>()
    for (const f of flattenTasks(project.tasks)) {
      const k = taskExt(f.task).key
      if (k) idOf.set(k, f.task.id)
    }
    patch.dependencies = theirs.blockedBy.map((k) => idOf.get(k)).filter((id): id is string => Boolean(id))
  }
  const jx: Record<string, unknown> = { ...ext, shadow: theirs }
  Reflect.deleteProperty(jx, 'reconciled')
  Reflect.deleteProperty(jx, 'conflict')
  patch.ext = { ...task.ext, [JIRA_ID]: jx }
  await plugin.store.applyExternalUpdates(project, [{ taskId: task.id, patch }])
}

/**
 * Why a description must not be written back, or null when it's safe.
 *
 * The conversion is lossy in one direction that matters: anything we couldn't represent
 * came through as a placeholder, and pushing that text would replace the real node in
 * Jira with the words describing it — an attachment becomes the literal string
 * "[jira attachment <id>]" and the file is gone from the issue.
 *
 * Blanking a description Jira has is refused for the same reason: it's far more often a
 * task whose body we failed to read than a deliberate deletion, and the cost of being
 * wrong is someone else's writing.
 */
function unpushableDescription(mine: string, theirs: string, stash: unknown): string | null {
  const lost = unrestorablePlaceholders(mine, stash as AdfStash | undefined)
  if (lost.length) return `${lost.join(', ')} can no longer be restored — edit that part in Jira`
  if (!mine.trim() && theirs.trim()) return 'it is empty here and not in Jira — refusing to clear it'
  return null
}

/**
 * The native `assignee` value to push for a task:
 *   - no assignee        → `null` (explicit unassign)
 *   - mapped assignee    → `{ accountId }`
 *   - assignee unmapped  → `undefined` (leave JIRA's value untouched — don't clobber)
 */
function assigneeField(plugin: PMPlugin, task: Task, cfg: JiraProjectConfig): { accountId: string } | null | undefined {
  if (!task.assignees[0]) return null
  const am = sharedAssignees(plugin, cfg).find((e) => e.name === task.assignees[0])
  return am?.jiraUser ? { accountId: am.jiraUser } : undefined
}

/**
 * Plan for assigning issue types when creating issues: a child is created exactly one
 * hierarchy level below its parent (Initiative → Epic → Task → Sub-task). Tracks each
 * key's level so a chain of new issues resolves correctly.
 */
interface TypePlan {
  rootLevel: number
  levelByKey: Map<string, number>
  typeAt(level: number): string | null
  levelOf(typeName: string): number | undefined
}

async function buildTypePlan(client: JiraClient, cfg: JiraProjectConfig): Promise<TypePlan> {
  const types = await client.issueTypes(cfg.epicId)
  const root = await client.getIssue(cfg.epicId)
  const rootLevel = (root ? levelOfType(types, root.issueType) : undefined) ?? 1
  return {
    rootLevel,
    levelByKey: new Map([[cfg.epicId, rootLevel]]),
    typeAt: (level) => typeForLevel(types, level),
    levelOf: (name) => levelOfType(types, name)
  }
}

/**
 * Resolve the create type for a task whose JIRA parent is `parentKey` (one level below
 * the parent), recording the result. Returns null when the task would nest below the
 * lowest type (e.g. under a Sub-task) — too deep for JIRA, so the caller skips + flags it.
 */
async function childTypeFor(
  client: JiraClient,
  plan: TypePlan,
  parentKey: string
): Promise<{ typeName: string; level: number } | null> {
  let parentLevel = plan.levelByKey.get(parentKey)
  if (parentLevel === undefined) {
    // Parent was linked in an earlier run — discover its level from its issue type.
    const issue = await client.getIssue(parentKey)
    parentLevel = (issue ? plan.levelOf(issue.issueType) : undefined) ?? plan.rootLevel
    plan.levelByKey.set(parentKey, parentLevel)
  }
  const level = parentLevel - 1
  const typeName = plan.typeAt(level)
  return typeName ? { typeName, level } : null
}

/**
 * Write an edit, walking it through legal intermediate states when a move across
 * hierarchy levels is refused as one request.
 *
 * Jira validates `parent` against the issue's *current* type, so "become a Task and take
 * this Epic as parent" is rejected outright: while it's still an Epic, an Epic parent is
 * the wrong level ("Given parent work item does not belong to appropriate hierarchy").
 * Changing only the type doesn't help either — the parent it already has (the Initiative
 * above it) becomes the wrong level the moment it stops being an Epic.
 *
 * So detach, convert, re-attach. Every step leaves the issue in a state Jira accepts: an
 * Epic with no parent, then a Task with no parent, then a Task under its Epic.
 *
 * A partly-applied move is safe. The next sync still sees the parent diverged and picks up
 * where this left off, so a failure halfway never needs manual repair.
 */
async function pushEdit(client: JiraClient, key: string, fields: Record<string, unknown>): Promise<boolean> {
  if (await client.editIssue(key, fields)) return true
  const { issuetype, ...rest } = fields
  if (!issuetype || !rest.parent) return false
  console.warn(`[PM] Jira: ${key} — retrying the level change as detach → convert → re-attach.`)
  if (!(await client.editIssue(key, { parent: null }))) return false
  if (!(await client.editIssue(key, { issuetype }))) return false
  return client.editIssue(key, rest)
}

/** The native priority reference to write: prefer the persisted id, fall back to the name. */
function priorityRef(entry: JiraValueMap): { id: string } | { name: string } {
  return entry.id ? { id: entry.id } : { name: entry.jira }
}

/** Native JIRA create payload (status set afterward via a transition; milestone via a property). */
function createFields(
  task: Task,
  parentKey: string,
  typeName: string,
  cfg: JiraProjectConfig,
  startField: string,
  plugin: PMPlugin
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    project: { key: projectKey(cfg) },
    issuetype: { name: typeName },
    summary: task.title,
    parent: { key: parentKey }
  }
  if (task.description.trim()) fields.description = markdownToAdf(task.description)
  if (task.due) fields.duedate = task.due
  if (startField && task.start) fields[startField] = task.start
  const priority = mapOutboundEntry(cfg.priorityMap, task.priority)
  if (priority) fields.priority = priorityRef(priority)
  const assignee = assigneeField(plugin, task, cfg)
  if (assignee !== undefined) fields.assignee = assignee
  return fields
}

/** Create one issue for a task (status via transition, milestone via property). Returns its key or null. */
async function pushNewIssue(
  plugin: PMPlugin,
  client: JiraClient,
  cfg: JiraProjectConfig,
  task: Task,
  parentKey: string,
  typeName: string,
  startField: string
): Promise<string | null> {
  const created = await client.createIssue(createFields(task, parentKey, typeName, cfg, startField, plugin))
  if (!('key' in created)) {
    console.error('[PM] Jira create failed', created.error)
    return null
  }
  const status = mapOutboundEntry(cfg.statusMap, task.status)
  if (status) await client.transitionTo(created.key, status.jira, status.id)
  await client.setProperty(created.key, ISSUE_PROP, { milestone: task.type === 'milestone' } satisfies JiraIssueProps)
  return created.key
}

/** The JIRA keys a task should be "blocked by" — its dependencies that have a key. */
function desiredBlockerKeys(task: Task, keyOf: Map<string, string>): string[] {
  return (task.dependencies ?? []).map((d) => keyOf.get(d)).filter((k): k is string => Boolean(k))
}

/**
 * Reconcile an issue's "is blocked by" links to exactly `desiredBlockerKeys`:
 * create the missing ones and delete the removed ones (links are a separate JIRA
 * resource, so this is the only way to two-way sync dependencies).
 */
async function reconcileLinks(
  client: JiraClient,
  blockedKey: string,
  currentLinks: { id: string; key: string }[],
  desired: string[]
): Promise<boolean> {
  const want = new Set(desired)
  let ok = true
  for (const k of want) {
    if (!currentLinks.some((l) => l.key === k)) ok = (await client.createLink(blockedKey, k)) && ok
  }
  for (const l of currentLinks) {
    if (!want.has(l.key)) ok = (await client.deleteLink(l.id)) && ok
  }
  return ok
}

// ── Epic-wide mapping config (shared via the epic's entity property) ────────────

function epicConfigOf(cfg: JiraProjectConfig): JiraEpicConfig {
  return { statusMap: cfg.statusMap, priorityMap: cfg.priorityMap }
}

/** Merge a remote epic config into local maps (adopt others' additions; no clobber). */
function mergeEpicConfig(cfg: JiraProjectConfig, remote: JiraEpicConfig): void {
  // Dedup by JIRA value (a status/priority maps to ONE of ours): keep the local
  // rule for a JIRA value, only adopt remote rules for JIRA values we don't have.
  const addValues = (local: JiraValueMap[], rem: JiraValueMap[] = []) => {
    for (const r of rem) {
      if (!local.some((e) => e.jira.toLowerCase() === r.jira.toLowerCase())) local.push(r)
    }
  }
  addValues(cfg.statusMap, remote.statusMap)
  addValues(cfg.priorityMap, remote.priorityMap)
}

async function pullEpicConfig(client: JiraClient, cfg: JiraProjectConfig): Promise<void> {
  if (!cfg.epicId) return // no epic configured yet — `/issue//properties/…` is a malformed request
  const remote = (await client.getProperty(cfg.epicId, CONFIG_PROP)) as JiraEpicConfig | undefined
  if (remote) {
    mergeEpicConfig(cfg, remote)
    return
  }
  // No config on the epic yet: bootstrap it from our local maps on the next push.
  if (cfg.statusMap.length || cfg.priorityMap.length) cfg.mappingsDirty = true
}

async function pushEpicConfig(client: JiraClient, cfg: JiraProjectConfig): Promise<void> {
  if (!cfg.mappingsDirty || !cfg.epicId) return
  await client.setProperty(cfg.epicId, CONFIG_PROP, epicConfigOf(cfg))
  cfg.mappingsDirty = false
}

/**
 * Carry a rename to every other project on the same Jira server that knew the old name:
 * its member list and every task assigned to them. One mapping serves all of them, so a
 * name changed in only one place would leave the others with tasks assigned to someone
 * who is no longer on the team — which reads as unassigned.
 *
 * Only projects that already knew the name are touched. That part matters: renameAssignee
 * adds the new name when the old one is absent, which would quietly put the person on
 * projects they have nothing to do with. Returns how many projects changed.
 */
let renaming = false

export async function renameAcrossProjects(
  plugin: PMPlugin,
  serverId: string,
  from: string,
  to: string,
  skipFilePath?: string
): Promise<number> {
  if (!from || from === to) return 0
  // Each project this renames fires the store's rename hook, which lands back here.
  // Whoever started the walk finishes it; the nested calls are no-ops.
  if (renaming) return 0
  renaming = true
  try {
    return await walkRename(plugin, serverId, from, to, skipFilePath)
  } finally {
    renaming = false
  }
}

async function walkRename(
  plugin: PMPlugin,
  serverId: string,
  from: string,
  to: string,
  skipFilePath?: string
): Promise<number> {
  let projects: Project[] = []
  try {
    projects = await plugin.store.loadAllProjects(plugin.settings.projectsFolder)
  } catch (e) {
    console.warn('[PM] Jira: could not carry the rename to the other projects', e)
    return 0
  }
  let touched = 0
  for (const other of projects) {
    if (skipFilePath && other.filePath === skipFilePath) continue // the caller already did this one
    const otherCfg = projectCfg(other)
    if (!otherCfg?.enabled || otherCfg.serverId !== serverId) continue
    const knows =
      other.teamMembers.includes(from) || flattenTasks(other.tasks).some((f) => f.task.assignees.includes(from))
    if (!knows) continue
    plugin.store.renameAssignee(other, from, to)
    await plugin.store.saveProject(other)
    touched++
  }
  if (touched) {
    plugin.refreshProjectViews()
    console.debug(`[PM] Jira: renamed "${from}" → "${to}" across ${touched} project(s).`)
  }
  return touched
}

// ── Setup / import (all over HTTP) ────────────────────────────────────────────

export function importedKeys(project: Project): Set<string> {
  const keys = new Set<string>()
  for (const f of flattenTasks(project.tasks)) {
    const k = taskExt(f.task).key
    if (k) keys.add(k)
  }
  return keys
}

async function issueToTask(
  plugin: PMPlugin,
  issue: JiraIssue,
  client: JiraClient,
  cfg: JiraProjectConfig,
  project: Project,
  fallback: string
): Promise<Task> {
  const assignee = resolveAssignee(plugin, project, issue)
  const task = makeTask({
    title: issue.summary || issue.key,
    // Imported once, into the note's body. Not part of the synced field set yet, so an
    // edit on either side stays where it was made.
    description: issue.description,
    type: issue.milestone ? 'milestone' : 'task',
    status: mapInbound(cfg.statusMap, issue.status, fallback),
    priority: mapPriority(issue, cfg),
    start: issue.start ?? '',
    due: issue.due ?? '',
    assignees: assignee ? [assignee] : [],
    ext: { [JIRA_ID]: { key: issue.key, sync: true } }
  })
  // Baseline for future field-level diffs. `blockedBy` is taken straight from the
  // issue (JIRA keys); the local `task.dependencies` are wired up by the caller after
  // all tasks exist, so they aren't available here.
  ensureTaskExt(task).shadow = { ...shadowOf(task), blockedBy: [...issue.blockedBy] }
  return task
}

/**
 * Load the project settings: adopt the shared epic config (status/priority/assignee
 * maps), create team members for any adopted assignee mappings (like import), then
 * prefill from the instance's JIRA statuses + priorities.
 */
export async function loadMappingValues(
  plugin: PMPlugin,
  project: Project
): Promise<{ statusesAdded: number; prioritiesAdded: number }> {
  const r = await ready(plugin, project)
  if (!r) return { statusesAdded: 0, prioritiesAdded: 0 }
  const { client, cfg } = r
  await pullEpicConfig(client, cfg) // status + priority maps from the epic
  const jiraStatuses = cfg.epicId ? await client.projectStatuses(cfg.epicId) : []
  // Scope to the mapped project: its priority scheme may expose only a subset of the
  // instance's priorities, and writing one outside it is rejected on create/edit.
  const jiraPriorities = await client.priorities(cfg.epicId)
  const beforeStatuses = cfg.statusMap.length
  const beforePriorities = cfg.priorityMap.length
  cfg.statusMap = mergeStatusMap(cfg.statusMap, jiraStatuses, plugin.settings.statuses)
  cfg.priorityMap = mergePriorityMap(cfg.priorityMap, jiraPriorities, plugin.settings.priorities)
  if (cfg.statusMap.length !== beforeStatuses || cfg.priorityMap.length !== beforePriorities) cfg.mappingsDirty = true
  // Persist immediately (like import) so loaded settings hit disk. ensureCreated
  // materializes a brand-new modal project (no file yet) before writing into it.
  await plugin.store.ensureCreated(project, plugin.settings.projectsFolder)
  return {
    statusesAdded: cfg.statusMap.length - beforeStatuses,
    prioritiesAdded: cfg.priorityMap.length - beforePriorities
  }
}

export async function searchJiraUsers(
  plugin: PMPlugin,
  project: Project,
  query: string
): Promise<{ accountId: string; displayName: string }[]> {
  const r = await ready(plugin, project)
  return r ? r.client.userPicker(query) : []
}

/**
 * Every issue under the top node across the whole hierarchy (Initiative → Epic → Task →
 * Sub-task, etc.), not just its direct children. The top level uses `epicChildren`
 * (`parent` or legacy "Epic Link"); deeper levels follow `parent` only, since sub-items
 * are always parent-linked. Breadth-first, batching each level's keys into one
 * `parent in (...)` query — so the tree is fetched in O(depth) requests, never N+1.
 */
async function epicDescendants(client: JiraClient, epicKey: string): Promise<JiraIssue[]> {
  const out = await client.epicChildren(epicKey)
  const seen = new Set(out.map((i) => i.key))
  let frontier = out.map((i) => i.key)
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const kids = (await client.subtasksOf(frontier)).filter((k) => !seen.has(k.key))
    if (!kids.length) break
    for (const k of kids) seen.add(k.key)
    out.push(...kids)
    frontier = kids.map((k) => k.key)
  }
  return out
}

export async function fetchEpicStories(plugin: PMPlugin, project: Project): Promise<JiraIssue[]> {
  const r = await ready(plugin, project)
  if (!r || !r.cfg.epicId) return []
  await r.client.startFieldId(r.cfg.epicId) // discover start field so search requests + parses it
  return epicDescendants(r.client, r.cfg.epicId)
}

export async function importStories(
  plugin: PMPlugin,
  project: Project,
  stories: JiraIssue[]
): Promise<{ created: number }> {
  const r = await ready(plugin, project)
  if (!r) return { created: 0 }
  const { client, cfg } = r
  if (cfg.epicId) await client.startFieldId(cfg.epicId) // so the search parses the start field
  await pullEpicConfig(client, cfg)
  // Imported tasks become files under the project folder, so make sure the project
  // itself exists first (a brand-new modal project has no file until now).
  await plugin.store.ensureCreated(project, plugin.settings.projectsFolder)
  const fallback = plugin.settings.statuses[0]?.id ?? 'todo'
  const already = importedKeys(project)
  // `stories` is the full selected subtree (from fetchEpicStories); import all of it.
  const picked = stories.filter((s) => !already.has(s.key))
  if (!picked.length) return { created: 0 }

  const byKey = new Map<string, { issue: JiraIssue; task: Task }>()
  for (const issue of picked) {
    byKey.set(issue.key, { issue, task: await issueToTask(plugin, issue, client, cfg, project, fallback) })
  }
  // key → local task id, for this batch AND tasks already imported earlier, so a child
  // nests under a parent that was imported in a previous run.
  const keyToId: Record<string, string> = {}
  for (const f of flattenTasks(project.tasks)) {
    const k = taskExt(f.task).key
    if (k) keyToId[k] = f.task.id
  }
  byKey.forEach((v, k) => (keyToId[k] = v.task.id))
  byKey.forEach(({ issue, task }) => {
    task.dependencies = issue.blockedBy.map((k) => keyToId[k]).filter((id): id is string => Boolean(id))
  })
  // Nest under the parent whenever it resolves to a task — covers Jira Sub-tasks AND a
  // regular issue whose parent is another story under the epic. (The epic itself isn't
  // imported, so the epic's direct children stay top-level.)
  const entries = [...byKey.values()].map(({ issue, task }) => ({
    task,
    parentId: (issue.parentKey && keyToId[issue.parentKey]) || null
  }))

  cfg.lastSeenUpdated = picked.reduce((m, i) => (i.updated > m ? i.updated : m), cfg.lastSeenUpdated ?? '')
  await plugin.store.importTasks(project, entries)
  return { created: entries.length }
}

/**
 * Match incoming issues to existing unlinked tasks by exact title (trimmed,
 * case-insensitive) so importing an issue you already track locally reconciles instead of
 * silently creating a duplicate. Only *unambiguous* matches are returned — a title shared
 * by more than one local task, or a task already claimed by an earlier issue, is left for
 * the user to resolve by hand. Returns issueKey → taskId.
 */
export function autoMatchByTitle(stories: { key: string; summary: string }[], tasks: Task[]): Map<string, string> {
  const byTitle = new Map<string, Task | null>() // null marks an ambiguous title (>1 candidate)
  for (const t of tasks) {
    if (taskExt(t).key) continue // already linked to an issue
    const norm = t.title.trim().toLowerCase()
    if (!norm) continue
    byTitle.set(norm, byTitle.has(norm) ? null : t)
  }
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const s of stories) {
    const t = byTitle.get((s.summary || '').trim().toLowerCase())
    if (t && !used.has(t.id)) {
      out.set(s.key, t.id)
      used.add(t.id)
    }
  }
  return out
}

/**
 * Link existing (keyless) Obsidian tasks to incoming Jira issues instead of importing
 * duplicates. Each pair sets the task's key + sync flag. Where the task's synced fields
 * already match the issue it links cleanly (shadow = the issue). Where they differ, the
 * task is flagged as a conflict with the Jira snapshot captured, so every difference is a
 * per-field decision in the merge editor — neither side silently wins (dependencies are
 * left to reconcile on a later normal sync, not at match time).
 */
export async function linkStoriesToTasks(
  plugin: PMPlugin,
  project: Project,
  pairs: { issueKey: string; taskId: string }[]
): Promise<{ linked: number; conflicted: number }> {
  const r = await ready(plugin, project)
  if (!r || !pairs.length) return { linked: 0, conflicted: 0 }
  const { client, cfg } = r
  if (cfg.epicId) await client.startFieldId(cfg.epicId) // so the fetch parses the start field
  await pullEpicConfig(client, cfg)
  await plugin.store.ensureCreated(project, plugin.settings.projectsFolder)
  const fallback = plugin.settings.statuses[0]?.id ?? 'todo'

  const issueByKey = new Map((await client.issuesByKeys(pairs.map((p) => p.issueKey))).map((i) => [i.key, i]))
  const taskById = new Map(flattenTasks(project.tasks).map((f) => [f.task.id, f.task]))

  const patches: { taskId: string; patch: Partial<Task> }[] = []
  let conflicted = 0
  for (const { issueKey, taskId } of pairs) {
    const issue = issueByKey.get(issueKey)
    const task = taskById.get(taskId)
    if (!issue || !task || taskExt(task).key) continue // missing, or already linked — skip
    const assigneeName = resolveAssignee(plugin, project, issue)
    const theirs: JiraShadow = {
      title: issue.summary || task.title,
      status: mapInbound(cfg.statusMap, issue.status, fallback),
      priority: mapPriority(issue, cfg),
      description: issue.description,
      start: issue.start ?? '',
      due: issue.due ?? '',
      assignees: assigneeName ? [assigneeName] : [],
      milestone: issue.milestone,
      blockedBy: [] // deps reconcile on a later normal sync, not at match time
    }
    const mine: JiraShadow = { ...shadowOf(task), blockedBy: [] }
    const differs = SYNC_FIELDS.some((f) => !fieldsEqual(mine[f], theirs[f], f))
    const jx: Record<string, unknown> = { ...taskExt(task), key: issue.key, sync: true }
    if (differs) {
      // Keep local values; capture the Jira snapshot but leave shadow unset so the merge
      // editor has no common base — every differing field becomes an explicit per-field
      // decision (default keep-mine) instead of silently taking the Jira side.
      jx.reconciled = false
      jx.conflict = { theirs }
      conflicted++
    } else {
      jx.shadow = theirs // identical → clean, in-sync link
    }
    patches.push({ taskId: task.id, patch: { ext: { ...task.ext, [JIRA_ID]: jx } } })
  }
  await pushEpicConfig(client, cfg) // resolveAssignee may have added a mapping
  await plugin.store.applyExternalUpdates(project, patches)
  return { linked: patches.length, conflicted }
}

/** A task not yet linked to a JIRA issue — a candidate for export. */
export interface ExportCandidate {
  id: string
  title: string
  type: string
  status: string
  due: string
  assignees: string[]
}

/** All tasks in the project without a JIRA key (in tree order), for the export picker. */
export function exportableTasks(project: Project): ExportCandidate[] {
  return flattenTasks(project.tasks)
    .filter((f) => !taskExt(f.task).key)
    .map((f) => ({
      id: f.task.id,
      title: f.task.title,
      type: f.task.type,
      status: f.task.status,
      due: f.task.due || '',
      assignees: f.task.assignees
    }))
}

/** Create JIRA issues for the selected (keyless) tasks, parent-first; links them back. */
export async function exportTasks(
  plugin: PMPlugin,
  project: Project,
  taskIds: string[]
): Promise<{ created: number; skipped: string[] }> {
  const r = await ready(plugin, project)
  if (!r || !r.cfg.epicId || !taskIds.length) return { created: 0, skipped: [] }
  const { client, cfg } = r
  await pullEpicConfig(client, cfg)
  const startField = await client.startFieldId(cfg.epicId)
  const plan = await buildTypePlan(client, cfg)
  const selected = new Set(taskIds)

  const flat = flattenTasks(project.tasks)
  const keyOf = new Map<string, string>()
  const parentOf = new Map<string, string | null>()
  for (const f of flat) {
    parentOf.set(f.task.id, f.parentId)
    const k = taskExt(f.task).key
    if (k) keyOf.set(f.task.id, k)
  }

  const patches: { taskId: string; patch: Partial<Task> }[] = []
  const createdIds = new Set<string>()
  const skipped: string[] = []
  for (const f of flat) {
    if (!selected.has(f.task.id) || taskExt(f.task).key) continue
    const parentId = parentOf.get(f.task.id) ?? null
    // A subtask whose parent has no issue must NOT fall back to the epic — that silently
    // creates it a level too high (an Epic instead of a child). Skip until the parent is
    // synced; exporting the parent in the same run is fine, it's keyed before we get here.
    if (parentId && !keyOf.get(parentId)) {
      skipped.push(f.task.title)
      console.warn(`[PM] Jira export: "${f.task.title}" skipped — its parent task isn't synced to Jira yet.`)
      continue
    }
    const parentKey = (parentId ? keyOf.get(parentId) : undefined) ?? cfg.epicId
    const ct = await childTypeFor(client, plan, parentKey)
    if (!ct) {
      // Nested below JIRA's lowest type — can't create it; flag and move on.
      skipped.push(f.task.title)
      console.warn(`[PM] Jira export: "${f.task.title}" is nested too deep for the Jira hierarchy — skipped.`)
      continue
    }
    const key = await pushNewIssue(plugin, client, cfg, f.task, parentKey, ct.typeName, startField)
    if (!key) continue
    plan.levelByKey.set(key, ct.level)
    keyOf.set(f.task.id, key)
    createdIds.add(f.task.id)
    patches.push({ taskId: f.task.id, patch: { ext: withJiraKey(f.task, key, keyOf, cfg, startField, plugin) } })
  }
  for (const f of flat) {
    const blockedKey = createdIds.has(f.task.id) ? keyOf.get(f.task.id) : undefined
    if (blockedKey) await reconcileLinks(client, blockedKey, [], desiredBlockerKeys(f.task, keyOf))
  }
  await pushEpicConfig(client, cfg)
  await plugin.store.applyExternalUpdates(project, patches)
  return { created: patches.length, skipped }
}

/**
 * Add and/or remove keys from the project's ignore list in one save. Adding an
 * already-ignored key or removing a non-ignored one is a no-op; when nothing actually
 * changes no write happens. Used by the import dialog: unpicked *new* issues are added,
 * while any issue that was imported, linked, or a revealed-ignored issue left unpicked is
 * removed (un-ignored) so it returns to the normal pending list.
 */
export async function updateIgnoredKeys(
  plugin: PMPlugin,
  project: Project,
  opts: { add?: string[]; remove?: string[] }
): Promise<void> {
  const cfg = projectCfg(project)
  if (!cfg) return
  const set = new Set(cfg.ignoredKeys)
  let changed = false
  for (const k of opts.remove ?? []) {
    if (set.delete(k)) changed = true
  }
  for (const k of opts.add ?? []) {
    if (!set.has(k)) {
      set.add(k)
      changed = true
    }
  }
  if (!changed) return
  cfg.ignoredKeys = [...set]
  await plugin.store.saveProject(project)
}

/**
 * Wipe every trace of the plugin from the Jira side, then disconnect locally. Deletes the
 * per-issue `obsidian-pm` property from all linked issues and the `obsidian-pm-config`
 * property from the epic; the issues themselves are never touched. When the remote wipe
 * fully succeeds, the local Jira config is cleared and the Jira link stripped from every
 * task so nothing re-writes the metadata on a later sync. If any delete fails the local
 * disconnect is skipped so the user can retry. Returns null when the project isn't
 * connected.
 */
/** The project permissions that matter for two-way sync. */
const SYNC_PERMISSIONS = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'TRANSITION_ISSUES', 'ASSIGN_ISSUES']

export interface JiraDiagnosis {
  user?: string
  projectKey: string
  /** Permission name → granted, or null when the probe itself failed. */
  permissions: Record<string, boolean> | null
  error?: string
}

/**
 * Report what the configured token can actually do on the mapped project. Creates
 * nothing — it asks Jira directly ("/mypermissions"), which is the decisive check when
 * reads work but writes 403 (a read-only/scoped token, or a missing project grant).
 */
export async function diagnoseAccess(plugin: PMPlugin, project: Project): Promise<JiraDiagnosis | null> {
  const r = await ready(plugin, project)
  if (!r) return null
  const { client, cfg } = r
  const key = projectKey(cfg)
  const conn = await client.testConnection()
  if (!conn.ok) return { projectKey: key, permissions: null, error: conn.error }
  const permissions = await client.myPermissions(key, SYNC_PERMISSIONS)
  return { user: conn.user, projectKey: key, permissions }
}

export async function cleanJira(
  plugin: PMPlugin,
  project: Project
): Promise<{ cleaned: number; failed: number; epic: boolean } | null> {
  const r = await ready(plugin, project)
  if (!r) return null
  const { client, cfg } = r

  const keys = flattenTasks(project.tasks)
    .map((f) => taskExt(f.task).key)
    .filter((k): k is string => Boolean(k))

  let cleaned = 0
  let failed = 0
  for (const key of keys) {
    if (await client.deleteProperty(key, ISSUE_PROP)) cleaned++
    else failed++
  }
  let epic = false
  if (cfg.epicId) {
    if (await client.deleteProperty(cfg.epicId, CONFIG_PROP)) epic = true
    else failed++
  }

  // Only disconnect locally once the remote is fully clean — otherwise keep the config so
  // the wipe can be retried (deletes are idempotent: an already-gone property is a no-op).
  // clearProjectCfg + a frontmatter save leave no stale Jira state (maps, ignoredKeys,
  // dirtyQueue, watermark all live under the cleared config block).
  if (!failed) {
    clearProjectCfg(project)
    const patches = flattenTasks(project.tasks)
      .filter((f) => taskExt(f.task).key || taskExt(f.task).sync)
      .map((f) => ({ taskId: f.task.id, patch: { ext: stripJira(f.task.ext) } }))
    await plugin.store.applyExternalUpdates(project, patches)
  }
  return { cleaned, failed, epic }
}

// ── Sync cycle (all reads/writes over the HTTP client) ────────────────────────

export interface SyncResult {
  changed: boolean
  jiraCreated: number // issues created in JIRA from local tasks
  jiraUpdated: number // existing issues edited/transitioned in JIRA
  obsidianUpdated: number // local tasks changed by the inbound pull
  membersAdded: number // team members auto-created locally this cycle
  conflicts: number // tasks left in limbo (local ⇄ JIRA diverged) this cycle
  /** Titles of tasks too deeply nested for the JIRA hierarchy to create (below Sub-task). */
  skippedTooDeep: string[]
  /** Tasks not created because their parent task isn't synced yet. */
  skippedNoParent: string[]
  /** Issues under the epic not yet a local task and not ignored — offered for import. */
  newIssues: JiraIssue[]
}

/** Options for {@link runSync}. */
export interface SyncOptions {
  /**
   * A **full** sync (default) crawls the whole epic subtree and pulls the shared epic
   * mapping config — used for manual sync and the import bootstrap. An **incremental**
   * sync (`full: false`, the periodic tick) pulls only the tracked subtree changed since
   * the watermark (plus locally-dirty issues) and skips the epic-config pull, so a
   * routine poll costs O(changes) requests instead of O(tree) + metadata every minute.
   */
  full?: boolean
  /**
   * Progress callback for long syncs. `done`/`total` are omitted for indeterminate
   * phases (metadata, fetching) and set while stepping through tasks.
   */
  onProgress?: (phase: string, done?: number, total?: number) => void
}

/**
 * One sync cycle, entirely over the JIRA REST client (mock or real). Pushes only
 * the strict minimum; reconciliation + the watermark stay local; the shared bit is
 * the epic's mapping config.
 */
export async function runSync(plugin: PMPlugin, project: Project, opts: SyncOptions = {}): Promise<SyncResult> {
  const full = opts.full !== false
  const r = await ready(plugin, project)
  const empty = { changed: false, jiraCreated: 0, jiraUpdated: 0, obsidianUpdated: 0, membersAdded: 0, conflicts: 0 }
  if (!r || !r.cfg.epicId) return { ...empty, skippedTooDeep: [], skippedNoParent: [], newIssues: [] }
  const { client, cfg } = r
  const progress = opts.onProgress ?? ((): void => undefined)
  progress('Reading Jira metadata…')
  const startField = await client.startFieldId(cfg.epicId)
  // The type plan needs /issuetype + the root issue; only built when we actually have a
  // new task to create, so a routine "check for changes" tick fetches no type metadata.
  let typePlan: TypePlan | null = null
  const skippedTooDeep: string[] = []
  const skippedNoParent: string[] = []
  const fallback = plugin.settings.statuses[0]?.id ?? 'todo'
  const membersBefore = project.teamMembers.length

  // Adopt any mapping updates other users published to the epic. The epic config has no
  // `updated` watermark (entity-property writes don't bump it), so it can't be polled
  // incrementally — only a full sync pulls it; periodic ticks rely on the last full sync.
  if (full) await pullEpicConfig(client, cfg)

  const flat = flattenTasks(project.tasks)
  const byKey = new Map<string, Task>()
  const keyOf = new Map<string, string>()
  const parentOf = new Map<string, string | null>()
  for (const f of flat) {
    parentOf.set(f.task.id, f.parentId)
    const k = taskExt(f.task).key
    if (k) {
      byKey.set(k, f.task)
      keyOf.set(f.task.id, k)
    }
  }
  // Descriptions live in the note body, which loads lazily — an unread body reads as ''.
  // Now that the description is a synced field, that would look like "the user cleared it"
  // and push an empty description over Jira's. Load them before anything compares.
  for (const f of flat) {
    const x = taskExt(f.task)
    if (x.key && x.sync) await plugin.store.loadTaskBody(f.task)
  }

  const createdKeys = new Set<string>()
  const createdIds = new Set<string>()

  let jiraUpdated = 0
  const patches: { taskId: string; patch: Partial<Task> }[] = []

  // 1. Create opted-in keyless tasks (parent-first). Only `sync === true` ones.
  const toCreate = flat.filter((f) => !taskExt(f.task).key && taskExt(f.task).sync === true).length
  let createdSoFar = 0
  for (const f of flat) {
    const ext = taskExt(f.task)
    if (ext.key || ext.sync !== true) continue
    progress('Creating issues in Jira', createdSoFar++, toCreate)
    typePlan = typePlan ?? (await buildTypePlan(client, cfg)) // lazy: only when creating
    const parentId = parentOf.get(f.task.id) ?? null
    // Same rule as export: never re-root a child onto the epic because its parent isn't
    // synced — that creates it one level too high. Wait for the parent instead.
    if (parentId && !keyOf.get(parentId)) {
      skippedNoParent.push(f.task.title)
      console.warn(`[PM] Jira sync: "${f.task.title}" not created — its parent task isn't synced to Jira yet.`)
      continue
    }
    const parentKey = (parentId ? keyOf.get(parentId) : undefined) ?? cfg.epicId
    const ct = await childTypeFor(client, typePlan, parentKey)
    if (!ct) {
      skippedTooDeep.push(f.task.title)
      console.warn(`[PM] Jira sync: "${f.task.title}" is nested too deep for the Jira hierarchy — not created.`)
      continue
    }
    const key = await pushNewIssue(plugin, client, cfg, f.task, parentKey, ct.typeName, startField)
    if (!key) continue
    typePlan.levelByKey.set(key, ct.level)
    keyOf.set(f.task.id, key)
    createdKeys.add(key)
    createdIds.add(f.task.id)
    patches.push({ taskId: f.task.id, patch: { ext: withJiraKey(f.task, key, keyOf, cfg, startField, plugin) } })
  }
  // Newly created issues have no links yet → add their dependencies.
  for (const f of flat) {
    const blockedKey = createdIds.has(f.task.id) ? keyOf.get(f.task.id) : undefined
    if (blockedKey) await reconcileLinks(client, blockedKey, [], desiredBlockerKeys(f.task, keyOf))
  }

  // 2. Reconcile every linked task with a 3-way merge against its JIRA issue
  //    (local vs the last-synced shadow vs JIRA). Disjoint changes merge: push the
  //    fields only we changed, adopt the fields only JIRA changed. A field both
  //    sides changed differently is a conflict — kept local and flagged for the UI.
  const prev = cfg.lastSeenUpdated ?? ''
  const trackedKeys = [...byKey.keys()]
  // Full sync: crawl the whole subtree. Incremental: pull only the tracked subtree
  // changed since the watermark, plus the issues behind locally-dirty tasks (whose JIRA
  // side may be unchanged but still need a push) — so an idle tick fetches nothing.
  progress('Fetching issues from Jira…')
  let all: JiraIssue[]
  if (full) {
    all = await epicDescendants(client, cfg.epicId)
  } else {
    const changed = await client.changedInSubtree(trackedKeys, cfg.epicId, prev)
    const have = new Set(changed.map((i) => i.key))
    const dirtyKeys = trackedKeys.filter((k) => {
      const t = byKey.get(k)
      if (!t) return false
      const ext = taskExt(t)
      return ext.reconciled === false || !ext.shadow || !shadowEqual(shadowOf(t, keyOf), ext.shadow)
    })
    const missing = dirtyKeys.filter((k) => !have.has(k))
    all = missing.length ? [...changed, ...(await client.issuesByKeys(missing))] : changed
  }
  const issueByKey = new Map(all.map((i) => [i.key, i]))

  let maxUpdated = prev
  for (const issue of all) if (issue.updated > maxUpdated) maxUpdated = issue.updated

  let obsidianUpdated = 0
  let conflicts = 0
  const newIssues: JiraIssue[] = []
  for (const issue of all) {
    if (byKey.has(issue.key) || createdKeys.has(issue.key) || cfg.ignoredKeys.includes(issue.key)) continue
    newIssues.push(issue) // under the epic, not local, not created this run, not ignored
  }

  const linked = flat.filter((f) => taskExt(f.task).sync && taskExt(f.task).key).length
  let checked = 0
  for (const f of flat) {
    const t = f.task
    const ext = taskExt(t)
    if (!ext.sync || !ext.key) continue
    progress('Reconciling tasks', checked++, linked)
    const issue = issueByKey.get(ext.key)
    if (!issue) continue // linked issue not under this epic — leave the task untouched
    const mine = shadowOf(t, keyOf)
    // Hierarchy is driven from Obsidian: the issue's Jira parent must match the task's
    // parent here. `parent` isn't one of the merged shadow fields, so compare it against
    // the issue directly — and treat a mismatch as divergence, or a pure reparent (no
    // other edit) would be skipped below and never reach Jira.
    const localParentId = parentOf.get(t.id) ?? null
    const desiredParent = localParentId ? keyOf.get(localParentId) : cfg.epicId
    const parentUnsynced = Boolean(localParentId) && !desiredParent
    const parentDiverged = parentUnsynced || (Boolean(desiredParent) && issue.parentKey !== desiredParent)
    const localDiverged = !ext.shadow || !shadowEqual(mine, ext.shadow) || parentDiverged

    // Nothing changed on either side and no open conflict → skip (no HTTP).
    if (!localDiverged && issue.updated <= prev && ext.reconciled !== false) continue

    // `theirs` from the issue (resolveAssignee may auto-create a mapped member).
    const assigneeName = resolveAssignee(plugin, project, issue)
    const theirs: JiraShadow = {
      title: issue.summary || t.title,
      status: mapInbound(cfg.statusMap, issue.status, fallback),
      priority: mapPriority(issue, cfg),
      description: issue.description,
      start: issue.start ?? '',
      due: issue.due ?? '',
      assignees: assigneeName ? [assigneeName] : [],
      milestone: issue.milestone,
      blockedBy: [...issue.blockedBy]
    }
    const baseShadow = ext.shadow ?? theirs // legacy task with no shadow: treat JIRA as the base
    const tw = threeWay(mine, baseShadow, theirs)

    if (tw.conflicts.length) {
      conflicts++
      patches.push({ taskId: t.id, patch: { ext: flagConflict(t, theirs) } }) // keep local; UI resolves it
      continue
    }

    // Push the fields only we changed. `held` names anything we couldn't write, so a
    // task stuck re-conflicting every sync says why instead of just reappearing.
    const held: string[] = []
    let ok = true
    const fields: Record<string, unknown> = {}
    if (tw.push.includes('title')) fields.summary = t.title
    if (tw.push.includes('due')) fields.duedate = t.due || null
    if (tw.push.includes('start')) {
      // No discovered start field = nowhere to write it. Don't drop it silently (that
      // would advance the shadow as if synced and lose the change) — hold it, same as an
      // unmapped assignee below.
      if (startField) fields[startField] = t.start || null
      else held.push('start (no "Start date" field on this Jira project)')
    }
    if (tw.push.includes('priority')) {
      const p = mapOutboundEntry(cfg.priorityMap, t.priority)
      if (p) fields.priority = priorityRef(p)
      else held.push(`priority "${t.priority}" (no Jira value mapped with "→ Jira")`)
    }
    if (parentUnsynced) held.push("parent (the parent task isn't synced to Jira yet)")
    else if (parentDiverged && desiredParent) {
      // Depth decides the Jira type, so a move across levels is a type change too: a task
      // that was top-level got created as the root's child type, and Jira rejects an issue
      // whose parent isn't exactly one level above it. Send the type with the parent so
      // the whole move is one legal edit.
      typePlan = typePlan ?? (await buildTypePlan(client, cfg))
      const ct = await childTypeFor(client, typePlan, desiredParent)
      if (!ct) {
        held.push('parent (the new parent is too deep for the Jira hierarchy)')
      } else {
        fields.parent = { key: desiredParent }
        if (ct.typeName.toLowerCase() !== issue.issueType.toLowerCase()) {
          fields.issuetype = { name: ct.typeName }
        }
      }
    }
    if (tw.push.includes('description')) {
      const why = unpushableDescription(t.description || '', issue.description, ext.adfStash)
      if (why) held.push(`description (${why})`)
      else fields.description = markdownToAdf(t.description || '', ext.adfStash as AdfStash | undefined)
    }
    if (tw.push.includes('assignees')) {
      const a = assigneeField(plugin, t, cfg)
      // `undefined` = a local assignee with no JIRA-user mapping. Don't silently drop
      // it (that would advance the shadow as if synced); surface it as a conflict so
      // the user maps the member instead of losing the change.
      if (a !== undefined) fields.assignee = a
      else held.push(`assignee "${t.assignees[0] ?? ''}" (no Jira user mapped)`)
    }
    if (Object.keys(fields).length && !(await pushEdit(client, ext.key, fields))) {
      const names = Object.keys(fields).join(', ')
      // A type change across the standard/sub-task boundary is the one edit Jira can
      // refuse outright, so name it rather than leaving a bare "rejected".
      held.push(
        fields.issuetype
          ? `fields ${names} (Jira rejected the edit — changing the issue type to "${(fields.issuetype as { name: string }).name}" may need a Move in Jira)`
          : `fields ${names} (Jira rejected the edit)`
      )
    }
    if (tw.push.includes('status')) {
      const s = mapOutboundEntry(cfg.statusMap, t.status)
      if (!s) held.push(`status "${t.status}" (no Jira status mapped with "→ Jira")`)
      else if (!(await client.transitionTo(ext.key, s.jira, s.id))) {
        held.push(`status "${t.status}" (no transition to "${s.jira}" available)`)
      }
    }
    if (tw.push.includes('milestone')) {
      const milestone = t.type === 'milestone'
      ok = (await client.setProperty(ext.key, ISSUE_PROP, { milestone } satisfies JiraIssueProps)) && ok
    }
    // Dependencies are part of the 3-way merge (via `blockedBy`); push them through
    // links only when we're the side that changed them, so an inbound link change
    // isn't clobbered by our (unchanged) local set.
    if (tw.push.includes('blockedBy')) {
      ok = (await reconcileLinks(client, ext.key, issue.blockLinks, desiredBlockerKeys(t, keyOf))) && ok
    }

    if (!ok || held.length) {
      conflicts++
      if (held.length) console.warn(`[PM] Jira: ${ext.key} held back — ${held.join('; ')}`)
      patches.push({ taskId: t.id, patch: { ext: flagConflict(t, theirs) } }) // a write was rejected — surface it
      continue
    }
    if (tw.push.length) jiraUpdated++

    // Adopt the fields only JIRA changed, plus its dependencies; advance the shadow.
    const patch: Partial<Task> = {}
    if (tw.adopt.includes('title')) patch.title = theirs.title
    if (tw.adopt.includes('status')) patch.status = theirs.status
    if (tw.adopt.includes('priority')) patch.priority = theirs.priority as TaskPriority
    if (tw.adopt.includes('start')) patch.start = theirs.start
    if (tw.adopt.includes('due')) patch.due = theirs.due
    if (tw.adopt.includes('assignees')) patch.assignees = [...theirs.assignees]
    if (tw.adopt.includes('milestone')) patch.type = theirs.milestone ? 'milestone' : 'task'
    // Writing this rewrites the note's body — applyExternalUpdates picks the full write.
    if (tw.adopt.includes('description')) patch.description = theirs.description
    // Adopt JIRA's dependency set only when it's the side that changed (map keys → local ids).
    if (tw.adopt.includes('blockedBy')) {
      patch.dependencies = theirs.blockedBy.map((k) => byKey.get(k)?.id).filter((tid): tid is string => Boolean(tid))
    }
    if (tw.adopt.length) obsidianUpdated++

    // Merged baseline: adopted fields take JIRA's value, the rest stay local.
    const a = (fld: keyof JiraShadow): boolean => tw.adopt.includes(fld)
    const merged: JiraShadow = {
      title: a('title') ? theirs.title : mine.title,
      status: a('status') ? theirs.status : mine.status,
      priority: a('priority') ? theirs.priority : mine.priority,
      start: a('start') ? theirs.start : mine.start,
      due: a('due') ? theirs.due : mine.due,
      assignees: a('assignees') ? [...theirs.assignees] : [...mine.assignees],
      milestone: a('milestone') ? theirs.milestone : mine.milestone,
      description: a('description') ? theirs.description : mine.description,
      blockedBy: a('blockedBy') ? [...theirs.blockedBy] : [...mine.blockedBy]
    }
    patch.ext = withMergedShadow(t, merged, tw.adopt.includes('description') ? issue.descriptionStash : undefined)
    patches.push({ taskId: t.id, patch })
  }
  cfg.dirtyQueue = []
  cfg.lastSeenUpdated = maxUpdated
  cfg.lastSyncAt = new Date().toISOString()

  // Publish local mapping changes to the epic (status + priority only).
  await pushEpicConfig(client, cfg)
  await plugin.store.applyExternalUpdates(project, patches)
  return {
    changed: patches.length > 0,
    jiraCreated: createdIds.size,
    jiraUpdated,
    obsidianUpdated,
    membersAdded: project.teamMembers.length - membersBefore,
    conflicts,
    skippedTooDeep,
    skippedNoParent,
    newIssues
  }
}
