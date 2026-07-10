/* eslint-disable import/no-nodejs-modules -- desktop-only in-process mock server */
// Type-only imports are erased, so `node:http`/`node:net` aren't required at module
// load — http is loaded lazily in start() via loadHttp() (returns null on mobile).
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type PMPlugin from '../../main'
import type { Project } from '../../types'
import { loadMock, saveMock, seedMeta, type JiraMockStore, type SeedInputs } from './JiraMock'
import { projectKeyOf } from './JiraModel'
import { serverById, servers, type JiraProjectConfig } from './types'

/**
 * An in-process HTTP server that speaks the subset of the JIRA Cloud REST API the
 * connector uses — reads AND writes. The real {@link JiraClient} is pointed at it
 * (site `localhost`), so every request/parse/error path is exercised exactly as
 * against real JIRA. Data lives in the hand-editable `jira-mock.json` via
 * {@link JiraMockStore}, reloaded per request so manual edits are picked up.
 *
 * Obsidian-free (IO injected) so it's unit-testable with an in-memory store.
 */
export class JiraMockServer {
  private server: Server | null = null
  /** OS-assigned port (listen(0)); 0 until started. */
  port = 0

  constructor(
    private loadStore: () => Promise<JiraMockStore>,
    private saveStore: (store: JiraMockStore) => Promise<void>
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    const http = await loadHttp()
    if (!http) return // unsupported environment (e.g. Obsidian mobile)
    const server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Defense in depth: bound to 127.0.0.1, but also refuse non-loopback callers.
      if (!isLoopback(req)) {
        send(res, 403, { error: 'forbidden: localhost only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/^\/rest\/api\/3/, '')
      const method = req.method ?? 'GET'
      const body = await readBody(req)
      const store = await this.loadStore()
      const result = route(store, method, path, url, body)
      if (result.mutated) await this.saveStore(store)
      send(res, result.status, result.body)
    } catch (e) {
      console.error('[PM-JIRA mock] request failed', e)
      send(res, 500, { error: 'mock server error' })
    }
  }
}

interface RouteResult {
  status: number
  body: unknown
  mutated?: boolean
}

/** Dispatch a request to a faithful JIRA endpoint handler. */
function route(store: JiraMockStore, method: string, path: string, url: URL, body: string): RouteResult {
  const m = store.data.meta

  if (path === '/myself') return ok({ accountId: 'mock-user', displayName: 'Mock User' })

  if (path === '/search/jql') return ok(searchJql(store, url)) // current Cloud endpoint
  if (path === '/search') return ok(search(store, url)) // legacy (kept for completeness)

  // /priority and /priority/search → instance priorities (with ids).
  if (path === '/priority/search') return ok({ values: m.priorities, isLast: true, total: m.priorities.length })
  if (path === '/priority') return ok(m.priorities)

  // Issue-type hierarchy (drives create-type resolution by level).
  if (path === '/issuetype') {
    return ok([
      { id: '1', name: 'Initiative', hierarchyLevel: 2, subtask: false },
      { id: '2', name: 'Epic', hierarchyLevel: 1, subtask: false },
      { id: '3', name: 'Story', hierarchyLevel: 0, subtask: false },
      { id: '4', name: 'Task', hierarchyLevel: 0, subtask: false },
      { id: '5', name: 'Sub-task', hierarchyLevel: -1, subtask: true }
    ])
  }

  if (path === '/user/picker') {
    const q = (url.searchParams.get('query') ?? '').toLowerCase()
    const users = m.users
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.accountId.toLowerCase().includes(q))
      .map((u) => ({ accountId: u.accountId, displayName: u.displayName }))
    return ok({ users })
  }

  const statuses = path.match(/^\/project\/([^/]+)\/statuses$/)
  if (statuses) {
    const list = m.statuses.map((s) => ({ id: s.id, name: s.name, statusCategory: s.statusCategory }))
    return ok([{ id: '10000', name: 'Task', subtask: false, statuses: list }])
  }

  // createmeta: issue types, then the fields for one (includes the Start custom field).
  const cmTypes = path.match(/^\/issue\/createmeta\/([^/]+)\/issuetypes$/)
  if (cmTypes) {
    return ok({
      startAt: 0,
      maxResults: 50,
      total: 2,
      isLast: true,
      values: [
        { id: '10000', name: 'Story', subtask: false },
        { id: '10001', name: 'Sub-task', subtask: true }
      ]
    })
  }
  const cmFields = path.match(/^\/issue\/createmeta\/([^/]+)\/issuetypes\/([^/]+)$/)
  if (cmFields) {
    return ok({
      startAt: 0,
      maxResults: 50,
      total: 4,
      isLast: true,
      values: [
        { fieldId: 'summary', name: 'Summary', required: true, hasDefaultValue: false, schema: { type: 'string' } },
        {
          fieldId: 'priority',
          name: 'Priority',
          required: false,
          hasDefaultValue: true,
          schema: { type: 'priority' },
          allowedValues: m.priorities
        },
        { fieldId: 'duedate', name: 'Due date', required: false, hasDefaultValue: false, schema: { type: 'date' } },
        {
          fieldId: m.startFieldId,
          name: 'Start date',
          required: false,
          hasDefaultValue: false,
          schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' }
        }
      ]
    })
  }

  // /issue/{key}/transitions
  const transitions = path.match(/^\/issue\/([^/]+)\/transitions$/)
  if (transitions) {
    const key = decodeURIComponent(transitions[1])
    if (!store.getIssue(key)) return notFound(key)
    if (method === 'POST') {
      const id = (safeParse(body) as { transition?: { id?: string } } | null)?.transition?.id ?? ''
      const updated = store.applyTransition(key, id)
      return updated
        ? { status: 204, body: null, mutated: true }
        : { status: 400, body: { errorMessages: ['bad transition'] } }
    }
    return ok({ transitions: store.transitionsFor(key) })
  }

  // /issue/{key}/properties/{propertyKey}
  const prop = path.match(/^\/issue\/([^/]+)\/properties\/([^/]+)$/)
  if (prop) {
    const key = decodeURIComponent(prop[1])
    const propKey = decodeURIComponent(prop[2])
    if (!store.getIssue(key)) return notFound(key)
    if (method === 'PUT') {
      store.setProperty(key, propKey, safeParse(body))
      return { status: 200, body: null, mutated: true }
    }
    if (method === 'DELETE') {
      const existed = store.deleteProperty(key, propKey)
      return existed ? { status: 204, body: null, mutated: true } : notFound(propKey)
    }
    const value = store.getProperty(key, propKey)
    return value === undefined ? notFound(propKey) : ok({ key: propKey, value })
  }

  // POST /issueLink (dependencies) — body: { type, inwardIssue, outwardIssue }.
  if (method === 'POST' && path === '/issueLink') {
    const b = safeParse(body) as { inwardIssue?: { key?: string }; outwardIssue?: { key?: string } } | null
    const blocked = b?.inwardIssue?.key // the "is blocked by" side
    const blocker = b?.outwardIssue?.key // the "blocks" side
    if (!blocked || !blocker || !store.getIssue(blocked) || !store.getIssue(blocker)) {
      return { status: 404, body: { errorMessages: ['issueLink endpoint(s) not found'] } }
    }
    store.addBlockLink(blocked, blocker)
    return { status: 201, body: null, mutated: true }
  }

  // DELETE /issueLink/{linkId}
  const link = path.match(/^\/issueLink\/([^/]+)$/)
  if (link && method === 'DELETE') {
    const id = decodeURIComponent(link[1])
    return store.removeLink(id) ? { status: 204, body: null, mutated: true } : notFound(id)
  }

  // POST /issue (create)
  if (method === 'POST' && path === '/issue') {
    const fields = (safeParse(body) as { fields?: Record<string, unknown> } | null)?.fields ?? {}
    const rec = store.createIssue(fields)
    return { status: 201, body: { id: rec.id, key: rec.key, self: `/rest/api/3/issue/${rec.key}` }, mutated: true }
  }

  // GET/PUT /issue/{key}
  const issue = path.match(/^\/issue\/([^/]+)$/)
  if (issue) {
    const key = decodeURIComponent(issue[1])
    if (method === 'PUT') {
      const fields = (safeParse(body) as { fields?: Record<string, unknown> } | null)?.fields ?? {}
      return store.editIssue(key, fields) ? { status: 204, body: null, mutated: true } : notFound(key)
    }
    const rec = store.getIssue(key)
    return rec ? ok({ id: rec.id, key: rec.key, fields: rec.fields }) : notFound(key)
  }

  return { status: 404, body: { errorMessages: [`No mock route for ${method} ${path}`] } }
}

/** Parse the comma-separated keys inside a `key in (...)` / `parent in (...)` clause. */
function clauseKeys(jql: string, clause: 'key' | 'parent'): string[] | null {
  const m = jql.match(new RegExp(`${clause} in \\(([^)]*)\\)`, 'i'))
  return m ? m[1].split(',').map((s) => s.replace(/["\s]/g, '')) : null
}

/** "2026-04-20T10:00:00.000+0000" / "2026-04-20 10:00" → "2026-04-20 10:00" for a minute-grained, tz-free compare. */
function minute(stamp: string): string {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : stamp
}

/**
 * Match + sort records for the JQL our JiraModel builders emit. The scope clauses
 * (`key in (...)`, `parent in (...)`, `parent = "X"`) combine with OR — matching real
 * JQL and the incremental `subtreeChangedJql` (tracked keys OR new children). `updated >`
 * filters by a minute-grained, timezone-free compare so the watermark behaves like JIRA.
 */
function matchJql(
  store: JiraMockStore,
  jql: string
): { id: string; key: string; fields: Record<string, unknown>; properties?: Record<string, unknown> }[] {
  const records = Object.values(store.data.issues)
  const keyIn = clauseKeys(jql, 'key')
  const parentIn = clauseKeys(jql, 'parent')
  const epic = jql.match(/parent = "([^"]+)"/i)?.[1]
  const since = jql.match(/updated > "([^"]+)"/i)?.[1]
  const parentKey = (r: { fields: Record<string, unknown> }): string =>
    (r.fields.parent as { key?: string } | undefined)?.key ?? ''

  // No scope clause → match everything (legacy full search). Otherwise OR the clauses.
  const scoped = Boolean(keyIn || parentIn || epic)
  let matched = scoped
    ? records.filter(
        (r) =>
          (keyIn?.includes(r.key) ?? false) ||
          (parentIn?.includes(parentKey(r)) ?? false) ||
          (epic !== undefined && parentKey(r) === epic)
      )
    : records
  const upd = (r: { fields: Record<string, unknown> }): string =>
    typeof r.fields.updated === 'string' ? r.fields.updated : ''
  if (since) matched = matched.filter((r) => minute(upd(r)) > minute(since))
  matched.sort((a, b) => upd(a).localeCompare(upd(b)))
  // Include entity properties inline (real Jira does this when the search requests
  // `properties=`), so the client reads the milestone flag without an N+1 GET per issue.
  return matched.map((r) => ({ id: r.id, key: r.key, fields: r.fields, properties: r.properties }))
}

/** Legacy GET /search — offset pagination + total (deprecated on Cloud). */
function search(store: JiraMockStore, url: URL): unknown {
  const startAt = Number(url.searchParams.get('startAt') ?? 0)
  const maxResults = Number(url.searchParams.get('maxResults') ?? 50)
  const matched = matchJql(store, url.searchParams.get('jql') ?? '')
  return { issues: matched.slice(startAt, startAt + maxResults), total: matched.length, startAt, maxResults }
}

/** Enhanced GET /search/jql — opaque nextPageToken paging, no `total` (current Cloud API). */
function searchJql(store: JiraMockStore, url: URL): unknown {
  const maxResults = Number(url.searchParams.get('maxResults') ?? 50)
  const from = Number(url.searchParams.get('nextPageToken') ?? 0)
  const matched = matchJql(store, url.searchParams.get('jql') ?? '')
  const page = matched.slice(from, from + maxResults)
  const next = from + page.length
  const isLast = next >= matched.length
  return { issues: page, isLast, ...(isLast ? {} : { nextPageToken: String(next) }) }
}

function ok(body: unknown): RouteResult {
  return { status: 200, body }
}
function notFound(what: string): RouteResult {
  return { status: 404, body: { errorMessages: [`Not found: ${what}`] } }
}
function safeParse(body: string): unknown {
  try {
    return JSON.parse(body || 'null')
  } catch {
    return null
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const peer = req.socket.remoteAddress ?? ''
  const peerOk = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const hostOk = host === '' || host === '127.0.0.1' || host === 'localhost' || host === '::1'
  return peerOk && hostOk
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === null ? '' : JSON.stringify(body))
}

// ── Plugin-level singleton (one server per plugin instance) ───────────────────

let running: JiraMockServer | null = null

export function isLocalhost(site: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)\b/i.test(site.trim())
}

export function hasLocalhostServer(plugin: PMPlugin): boolean {
  return servers(plugin).some((s) => isLocalhost(s.site))
}

type HttpModule = typeof import('node:http')

async function loadHttp(): Promise<HttpModule | null> {
  const req =
    typeof window === 'undefined' ? undefined : (window as Window & { require?: (m: string) => unknown }).require
  if (req) return req('node:http') as HttpModule
  try {
    return await import('node:http')
  } catch {
    return null // no Node (e.g. Obsidian mobile)
  }
}

/**
 * Start the shared mock server if a localhost JIRA server is configured and the
 * environment can host one. The DB is loaded lazily per request; `defaultProject`
 * seeds an empty instance's key prefix.
 */
export async function ensureMockServer(plugin: PMPlugin, defaultProject: string): Promise<void> {
  if (running || !hasLocalhostServer(plugin)) return
  const server = new JiraMockServer(
    () => loadMock(plugin, defaultProject),
    (s) => saveMock(plugin, s)
  )
  await server.start()
  if (!server.port) return
  running = server
  console.warn(`[PM-JIRA mock] serving on http://127.0.0.1:${server.port}`)
}

export function stopMockServer(): void {
  running?.stop()
  running = null
}

export function mockBaseUrl(site: string): string | null {
  if (!running?.port || !isLocalhost(site)) return null
  return `http://127.0.0.1:${running.port}/rest/api/3`
}

// ── Mock backend seeding (dev only) ───────────────────────────────────────────
// All of this is what a real JIRA instance already provides server-side: instance
// metadata, a user directory, and the epic issue. It exists ONLY so the in-process
// mock behaves like a populated instance. The core sync flow stays backend-agnostic
// and reaches it through the single `ensureMockBackend` hook below, which is inert
// for any non-localhost server.

/** A localhost mock instance keys its issues off the epic prefix (or "MOCK" when unset). */
const mockKey = (cfg: JiraProjectConfig): string => projectKeyOf(cfg.epicId) || 'MOCK'

/** A stable synthetic accountId for a team member (the mock's stand-in Jira users). */
const mockAccountId = (name: string): string =>
  `mock:${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`

/** Mock instance metadata derived from plugin settings + the project's team. */
function seedInputs(plugin: PMPlugin, project: Project): SeedInputs {
  const names = [...new Set([...plugin.settings.globalTeamMembers, ...project.teamMembers])].filter(Boolean)
  return {
    statuses: plugin.settings.statuses.map((s) => ({ name: s.label, complete: s.complete })),
    priorities: plugin.settings.priorities.map((p) => ({ name: p.label })),
    users: names.map((n) => ({ accountId: mockAccountId(n), displayName: n }))
  }
}

/**
 * Bring the in-process mock backend up to date for a project: start the server, seed
 * instance metadata (statuses/priorities) once, register the team as Jira users, and
 * ensure the epic exists as an issue. **No-op unless the project's server is the local
 * mock** — real Jira provides all of this server-side, so the core sync path can call
 * this unconditionally and stay backend-agnostic.
 */
export async function ensureMockBackend(plugin: PMPlugin, project: Project, cfg: JiraProjectConfig): Promise<void> {
  const site = serverById(plugin, cfg.serverId)?.site ?? ''
  if (!isLocalhost(site)) return
  await ensureMockServer(plugin, mockKey(cfg))

  const store = await loadMock(plugin, mockKey(cfg))
  let changed = false
  const seeds = seedInputs(plugin, project)
  if (!store.data.meta.statuses.length) {
    seedMeta(store, seeds)
    changed = true
  }
  // Keep the mock's user directory in step with the team, so members added after the
  // first seed are still found by the Jira user picker.
  const usersBefore = store.data.meta.users.length
  for (const u of seeds.users) store.registerUser(u.accountId, u.displayName)
  if (store.data.meta.users.length !== usersBefore) changed = true
  // The epic must exist as a real issue (like JIRA) so its mapping config lives in
  // entity properties; children/sync target it as their parent.
  if (cfg.epicId && !store.getIssue(cfg.epicId)) {
    store.ensureIssue(cfg.epicId, { summary: project.title, issuetype: { name: 'Epic' } })
    changed = true
  }
  if (changed) await saveMock(plugin, store)
}
