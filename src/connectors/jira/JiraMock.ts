import type PMPlugin from '../../main'

/**
 * The data layer for the mock JIRA instance, persisted as a hand-editable JSON
 * file in the plugin data folder. It stores issues in JIRA's *native* REST shape
 * (`{ id, key, fields }`) and a `meta` block that simulates instance config —
 * generated on first use and stored in the JSON:
 *   - a random custom-field id for "Start date" (JIRA has no built-in start field)
 *   - the status / priority / user lists (with ids), grown as issues reference them
 *
 * Nothing here is reachable directly by the plugin — every read/write goes through
 * {@link JiraMockServer}'s HTTP endpoints, so the real client paths are exercised.
 */

export interface JiraStatus {
  id: string
  name: string
  statusCategory: { id: number; key: string; name: string }
}
export interface JiraPriority {
  id: string
  name: string
}
export interface JiraUser {
  accountId: string
  displayName: string
}

export interface MockMeta {
  /** '' models a project with no "Start date" field at all. */
  startFieldId: string
  statuses: JiraStatus[]
  priorities: JiraPriority[]
  /** Priority names this project's scheme allows; unset = all of them. */
  priorityScheme?: string[]
  /**
   * How createmeta wraps its pages: the documented `values` envelope, or the named
   * collections (`issueTypes` / `fields`) Cloud also returns. Reading only one of them
   * is what silently disabled start-date discovery on a real site.
   */
  envelope?: 'values' | 'named'
  /** When set, the next write is refused with Jira's XSRF 403 (then cleared). */
  xsrfOnce?: boolean
  /** Refuse any edit that changes the issue type, as a site with a restricted scheme does. */
  rejectTypeChange?: boolean
  users: JiraUser[]
  seq: number
  /** Monotonic counter for minting issue-link ids. */
  linkSeq?: number
}

export interface MockIssueRecord {
  id: string
  key: string
  fields: Record<string, unknown>
  properties?: Record<string, unknown>
}

export interface MockDb {
  project: string
  meta: MockMeta
  issues: Record<string, MockIssueRecord>
}

/** JIRA's three status categories; we pick one by name when registering a status. */
function categoryFor(name: string): JiraStatus['statusCategory'] {
  const n = name.toLowerCase()
  if (/done|closed|complete|resolved|cancel|ship/.test(n)) return { id: 3, key: 'done', name: 'Done' }
  if (/progress|review|monitor|qa|doing/.test(n)) return { id: 4, key: 'indeterminate', name: 'In Progress' }
  return { id: 2, key: 'new', name: 'To Do' }
}

/** Current time in JIRA's `updated` shape (so seeded and written timestamps compare). */
function jiraNow(): string {
  return new Date().toISOString().replace('Z', '+0000')
}

function emptyMeta(rand: () => number): MockMeta {
  return {
    startFieldId: `customfield_${10000 + Math.floor(rand() * 9000)}`,
    statuses: [],
    priorities: [],
    users: [],
    seq: 0
  }
}

export function emptyDb(project: string, rand: () => number = Math.random): MockDb {
  return { project, meta: emptyMeta(rand), issues: {} }
}

/**
 * In-memory JIRA database. Pure and synchronous (file IO lives in loadMock/saveMock),
 * so it can be unit-tested; the HTTP server in JiraMockServer drives it.
 */
export class JiraMockStore {
  constructor(
    public data: MockDb,
    private now: () => string = jiraNow,
    private rand: () => number = Math.random
  ) {
    this.data.meta = this.data.meta ?? emptyMeta(this.rand)
    this.data.issues = this.data.issues ?? {}
  }

  get startFieldId(): string {
    return this.data.meta.startFieldId
  }
  /** Model a project with no "Start date" field by clearing it (''), as some sites have. */
  setStartFieldId(id: string): void {
    this.data.meta.startFieldId = id
  }
  /** Serve createmeta in the named-collection envelope instead of the paginated one. */
  setEnvelope(style: 'values' | 'named'): void {
    this.data.meta.envelope = style
  }
  /** Refuse the next write once with Jira's XSRF 403. */
  armXsrfFailure(): void {
    this.data.meta.xsrfOnce = true
  }
  /**
   * Refuse type changes, which real sites do — a scheme without the target type, a
   * workflow that won't allow the transition. It matters because the cross-level move
   * walk detaches BEFORE converting: a refusal here used to leave the issue parentless,
   * out of every subtree, and the next sync archived the local task instead of retrying.
   */
  setRejectTypeChange(on: boolean): void {
    this.data.meta.rejectTypeChange = on
  }

  /**
   * Restrict which priorities this project's scheme accepts (names). The instance-wide
   * list still reports them all — that gap is what makes an unscoped priority invalid.
   */
  setPriorityScheme(names: string[]): void {
    this.data.meta.priorityScheme = names
  }
  /** The priorities the project's scheme allows, defaulting to every instance priority. */
  get schemePriorities(): JiraPriority[] {
    const names = this.data.meta.priorityScheme
    if (!names?.length) return this.data.meta.priorities
    const want = new Set(names.map((n) => n.toLowerCase()))
    return this.data.meta.priorities.filter((p) => want.has(p.name.toLowerCase()))
  }

  // ── Instance metadata, seeded from settings + grown as issues reference values ─
  registerStatus(name: string, complete?: boolean): JiraStatus {
    const found = this.data.meta.statuses.find((s) => s.name.toLowerCase() === name.toLowerCase())
    if (found) return found
    const statusCategory = complete ? { id: 3, key: 'done', name: 'Done' } : categoryFor(name)
    const status: JiraStatus = { id: String(1000 + this.data.meta.statuses.length + 1), name, statusCategory }
    this.data.meta.statuses.push(status)
    return status
  }
  registerPriority(name: string): JiraPriority {
    const found = this.data.meta.priorities.find((p) => p.name.toLowerCase() === name.toLowerCase())
    if (found) return found
    const priority: JiraPriority = { id: String(1 + this.data.meta.priorities.length + 1), name }
    this.data.meta.priorities.push(priority)
    return priority
  }
  registerUser(accountId: string, displayName: string): JiraUser {
    let user = this.data.meta.users.find((u) => u.accountId === accountId)
    if (!user) {
      user = { accountId, displayName }
      this.data.meta.users.push(user)
    }
    return user
  }

  // ── Issues ───────────────────────────────────────────────────────────────────
  getIssue(key: string): MockIssueRecord | null {
    return this.data.issues[key] ?? null
  }

  /** Create an issue from native create `fields`; the store mints the id+key and initial status. */
  createIssue(fields: Record<string, unknown>): MockIssueRecord {
    this.data.meta.seq += 1
    const n = this.data.meta.seq
    const key = `${this.data.project}-${n}`
    const initial = this.data.meta.statuses[0] ?? this.registerStatus('To Do')
    const record: MockIssueRecord = {
      id: String(10000 + n),
      key,
      fields: { ...this.normalizeFields(fields), status: initial, updated: this.now() }
    }
    this.data.issues[key] = record
    return record
  }

  /**
   * Insert an issue with an explicit key (e.g. the epic, which in real JIRA must
   * exist before its children) if absent. Treated like any other issue thereafter —
   * entity properties, edits and transitions all apply.
   */
  ensureIssue(key: string, fields: Record<string, unknown>): MockIssueRecord {
    const existing = this.data.issues[key]
    if (existing) return existing
    const initial = this.data.meta.statuses[0] ?? this.registerStatus('To Do')
    const record: MockIssueRecord = {
      id: String(90000 + Object.keys(this.data.issues).length + 1),
      key,
      fields: { ...this.normalizeFields(fields), status: initial, updated: this.now() }
    }
    this.data.issues[key] = record
    return record
  }

  /** Merge an edit's native `fields` into an existing issue (status changes go via transitions). */
  editIssue(key: string, fields: Record<string, unknown>): MockIssueRecord | null {
    const rec = this.data.issues[key]
    if (!rec) return null
    if (this.data.meta.rejectTypeChange && fields.issuetype) return null
    Object.assign(rec.fields, this.normalizeFields(fields))
    rec.fields.updated = this.now()
    return rec
  }

  /** Resolve priority/assignee references and register any new metadata values. */
  private normalizeFields(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...fields }
    // JIRA's issuetype carries a `subtask` boolean; derive it from the name so reads are faithful.
    const it = fields.issuetype as { name?: string; subtask?: boolean } | undefined
    if (it?.name) out.issuetype = { name: it.name, subtask: it.subtask ?? /sub-?task/i.test(it.name) }
    const pr = fields.priority as { id?: string; name?: string } | undefined
    if (pr) {
      const found =
        this.data.meta.priorities.find((p) => p.id === pr.id) ?? (pr.name ? this.registerPriority(pr.name) : undefined)
      if (found) out.priority = found
    }
    const as = fields.assignee as { accountId?: string; displayName?: string } | null | undefined
    if (as && as.accountId) {
      const u = this.registerUser(as.accountId, as.displayName ?? as.accountId)
      out.assignee = u
    }
    return out
  }

  // ── Transitions (status changes) ──────────────────────────────────────────────
  transitionsFor(_key: string): { id: string; name: string; to: JiraStatus }[] {
    // Every configured status is reachable (the mock has no workflow restrictions).
    return this.data.meta.statuses.map((s) => ({ id: `t-${s.id}`, name: s.name, to: s }))
  }

  applyTransition(key: string, transitionId: string): MockIssueRecord | null {
    const rec = this.data.issues[key]
    if (!rec) return null
    const t = this.transitionsFor(key).find((x) => x.id === transitionId)
    if (!t) return null
    rec.fields.status = t.to
    rec.fields.updated = this.now()
    return rec
  }

  // ── Issue links (dependencies) ────────────────────────────────────────────────
  /**
   * Record a "Blocks" link: `blockedKey` is blocked by `blockerKey`. Stored on both
   * issues in JIRA's per-issue `issuelinks` shape (idempotent), so reads of the
   * blocked issue expose `{ type:{inward:'is blocked by'}, inwardIssue:{key} }`.
   */
  addBlockLink(blockedKey: string, blockerKey: string): void {
    const blocked = this.data.issues[blockedKey]
    const blocker = this.data.issues[blockerKey]
    if (!blocked || !blocker || blockedKey === blockerKey) return
    const linksOf = (rec: MockIssueRecord): Record<string, unknown>[] => {
      if (!Array.isArray(rec.fields.issuelinks)) rec.fields.issuelinks = []
      return rec.fields.issuelinks as Record<string, unknown>[]
    }
    const blockedLinks = linksOf(blocked)
    // Idempotent: one "Blocks" link per (blocked, blocker) pair.
    if (blockedLinks.some((l) => (l.inwardIssue as { key?: string } | undefined)?.key === blockerKey)) return
    this.data.meta.linkSeq = (this.data.meta.linkSeq ?? 0) + 1
    const id = String(20000 + this.data.meta.linkSeq)
    const type = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }
    // The same link id appears on both issues (JIRA's representation).
    blockedLinks.push({ id, type, inwardIssue: { key: blockerKey } })
    linksOf(blocker).push({ id, type, outwardIssue: { key: blockedKey } })
    // Linking bumps both issues' updated timestamp, like real JIRA.
    blocked.fields.updated = this.now()
    blocker.fields.updated = this.now()
  }

  /** Remove an issue link by id from whichever issues carry it. Returns true if found. */
  removeLink(id: string): boolean {
    let removed = false
    for (const rec of Object.values(this.data.issues)) {
      const links = rec.fields.issuelinks
      if (!Array.isArray(links)) continue
      const kept = (links as Record<string, unknown>[]).filter((l) => l.id !== id)
      if (kept.length !== links.length) {
        rec.fields.issuelinks = kept
        rec.fields.updated = this.now() // unlinking bumps updated too
        removed = true
      }
    }
    return removed
  }

  // ── Entity properties ─────────────────────────────────────────────────────────
  getProperty(key: string, propKey: string): unknown {
    return this.data.issues[key]?.properties?.[propKey]
  }
  setProperty(key: string, propKey: string, value: unknown): void {
    const rec = this.data.issues[key]
    if (!rec) return
    rec.properties = rec.properties ?? {}
    rec.properties[propKey] = value // does not bump updated, like real JIRA
  }
  /** Remove an entity property. Returns whether it existed. */
  deleteProperty(key: string, propKey: string): boolean {
    const props = this.data.issues[key]?.properties
    if (!props || !(propKey in props)) return false
    Reflect.deleteProperty(props, propKey)
    return true
  }
}

/** Instance metadata to seed a fresh mock with (from the plugin's settings). */
export interface SeedInputs {
  statuses: { name: string; complete: boolean }[]
  priorities: { name: string }[]
  users: { accountId: string; displayName: string }[]
}

/** Populate a fresh instance's status/priority/user lists (no-op once they exist). */
export function seedMeta(store: JiraMockStore, inputs: SeedInputs): void {
  if (store.data.meta.statuses.length === 0) for (const s of inputs.statuses) store.registerStatus(s.name, s.complete)
  if (store.data.meta.priorities.length === 0) for (const p of inputs.priorities) store.registerPriority(p.name)
  if (store.data.meta.users.length === 0) for (const u of inputs.users) store.registerUser(u.accountId, u.displayName)
}

function mockPath(plugin: PMPlugin): string {
  return `${plugin.manifest.dir ?? '.'}/jira-mock.json`
}

/** Load the mock DB for a project (creates an empty instance if absent/corrupt; seeds meta). */
export async function loadMock(plugin: PMPlugin, project: string, seed?: SeedInputs): Promise<JiraMockStore> {
  const path = mockPath(plugin)
  const adapter = plugin.app.vault.adapter
  let db: MockDb | null = null
  try {
    if (await adapter.exists(path)) db = JSON.parse(await adapter.read(path)) as MockDb
  } catch (e) {
    console.error('[PM] failed to read jira-mock.json; starting empty', e)
  }
  if (!db || !db.meta) db = emptyDb(project)
  const store = new JiraMockStore(db)
  if (seed) seedMeta(store, seed)
  return store
}

export async function saveMock(plugin: PMPlugin, store: JiraMockStore): Promise<void> {
  await plugin.app.vault.adapter.write(mockPath(plugin), JSON.stringify(store.data, null, 2))
}

/** Delete the mock DB file (used when the last localhost server is removed). */
export async function deleteMock(plugin: PMPlugin): Promise<boolean> {
  const adapter = plugin.app.vault.adapter
  const path = mockPath(plugin)
  if (!(await adapter.exists(path))) return false
  await adapter.remove(path)
  return true
}
