/* eslint-disable import/no-nodejs-modules -- desktop-only Node transport for real Jira */
import { requestUrl } from 'obsidian'
import type { JiraIssue, JiraIssueType } from './JiraModel'
import {
  epicChildrenJql,
  epicUpdatedSinceJql,
  keyInJql,
  normalizeIssue,
  parentInJql,
  projectKeyOf,
  subtreeChangedJql
} from './JiraModel'
import { ISSUE_PROP } from './types'

export interface JiraCreds {
  site: string // e.g. "acme.atlassian.net" (scheme optional)
  email: string
  token: string
  /** Override the REST base URL (e.g. the in-process localhost mock). */
  baseUrl?: string
}

/**
 * Read a list out of a Jira response that may be a bare array, a paginated `{values}`
 * envelope, or a named collection (`{issueTypes}` / `{fields}`) — Cloud uses all three
 * across the createmeta and field endpoints.
 */
function listOf<T>(data: unknown, named: string): T[] {
  if (Array.isArray(data)) return data as T[]
  const obj = (data ?? {}) as Record<string, unknown>
  for (const key of ['values', named]) {
    if (Array.isArray(obj[key])) return obj[key] as T[]
  }
  return []
}

/** Parse a response body as JSON, tolerating empty/non-JSON bodies (e.g. 204). */
function parseJson(text: string | undefined): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Verbose JIRA API logging — off by default; toggled by the connector's debug setting. */
let apiDebug = false
export function setJiraApiDebug(on: boolean): void {
  apiDebug = on
}

/**
 * Log one JIRA API exchange to the console (only when debug logging is on). Works for mock
 * and real. A failure whose body isn't JSON (empty, or an HTML page from a proxy/WAF in
 * front of Jira) would log as `null` and hide the reason, so the raw text and the response
 * headers are included too — Jira puts its refusal reason in `x-seraph-loginreason` /
 * `x-authentication-denied-reason`.
 */
function logApi(
  method: string,
  url: string,
  reqBody: unknown,
  status: number,
  resText: string | undefined,
  resHeaders?: Record<string, string | string[] | undefined>
): void {
  if (!apiDebug) return
  const parsed = parseJson(resText)
  const ok = status >= 200 && status < 300
  console.debug(`[PM-JIRA] ${method} ${url} → ${status}`, {
    request: reqBody,
    response: parsed,
    ...(parsed === null && !ok ? { rawBody: resText?.slice(0, 2000) ?? '(empty)', headers: resHeaders } : {})
  })
}

export interface JiraTransition {
  id: string
  name: string
  to: { id: string; name: string }
}

// Instance-stable metadata (start field, issue-type hierarchy) cached across the
// per-sync client instances by base URL — a routine sync re-creates the client but
// shouldn't re-discover these every time. Keyed by base so mock/real stay isolated.
const startFieldByBase = new Map<string, string>()
const issueTypesByBase = new Map<string, JiraIssueType[]>()
/** Priorities a project's scheme allows, keyed "<base>|<projectKey>". */
const prioritiesByProject = new Map<string, { name: string; id: string }[]>()

/**
 * Jira's XSRF token per base URL. Cloud hands one back as `atlassian.xsrf.token` and then
 * demands it on writes ("XSRF check failed", 403) whenever it treats the caller as a
 * browser — which Electron requests can look like. Echoing the value as both the cookie
 * and the `X-Atlassian-Token` header is the handshake a browser performs.
 */
const xsrfByBase = new Map<string, string>()

/**
 * Sites that answered a write with "XSRF check failed" even after the token handshake.
 * Their traffic moves to the Node transport for the rest of the session; everyone else
 * keeps using Obsidian's requestUrl.
 */
const nodeTransportBases = new Set<string>()

interface RawResponse {
  status: number
  text: string
  headers: Record<string, string | string[] | undefined>
}

type HttpsModule = typeof import('node:https')

/**
 * Obsidian's `requestUrl` goes through Electron's network stack, which attaches the
 * session's cookies and an app Origin. Jira Cloud then treats a write as browser traffic
 * and enforces XSRF ("XSRF check failed", 403) even though we authenticate with Basic —
 * and no token echo satisfies it. Node's https module has no cookie jar and no Origin, so
 * real Jira goes through it when Node is available (desktop). Null on mobile.
 */
async function loadHttps(): Promise<HttpsModule | null> {
  const req =
    typeof window === 'undefined' ? undefined : (window as Window & { require?: (m: string) => unknown }).require
  if (req) return req('node:https') as HttpsModule
  try {
    return await import('node:https')
  } catch {
    return null
  }
}

/** Issue a request over Node https — no cookies, no Origin, so no XSRF interception. */
async function nodeRequest(
  https: HttpsModule,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined
): Promise<RawResponse> {
  const u = new URL(url)
  return new Promise<RawResponse>((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        // No Accept-Encoding: Node won't decompress for us, so ask for plain text.
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'Content-Length': new TextEncoder().encode(body).length })
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }))
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Pull `atlassian.xsrf.token` out of a response's set-cookie header(s), if present. */
function readXsrfCookie(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  const raw = headers?.['set-cookie'] ?? headers?.['Set-Cookie']
  if (!raw) return undefined
  for (const line of Array.isArray(raw) ? raw : [raw]) {
    const m = /atlassian\.xsrf\.token=([^;]+)/.exec(line)
    if (m) return m[1]
  }
  return undefined
}

/**
 * JIRA Cloud REST client over Obsidian's requestUrl (which bypasses CORS). Every
 * read and write the connector performs goes through here, so the same code path
 * runs against the local mock (site `localhost`) and real JIRA.
 */
export class JiraClient {
  private readonly base: string
  private readonly auth: string
  /** Discovered custom-field id for "Start date" (JIRA has no built-in start field). */
  private startField: string | undefined

  constructor(creds: JiraCreds) {
    const site = creds.site.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    this.base = creds.baseUrl ?? `https://${site}/rest/api/3`
    this.auth = 'Basic ' + btoa(`${creds.email}:${creds.token}`)
  }

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const url = this.base + path
    const payload = body === undefined ? undefined : JSON.stringify(body)

    const send = async (): Promise<RawResponse> => {
      // Jira Cloud can decide a write came from a browser and demand its XSRF token.
      // `no-check` covers Server/DC; Cloud wants the token it issued echoed back.
      const xsrf = xsrfByBase.get(this.base)
      const headers: Record<string, string> = {
        Authorization: this.auth,
        Accept: 'application/json',
        'X-Atlassian-Token': xsrf ?? 'no-check',
        ...(xsrf ? { Cookie: `atlassian.xsrf.token=${xsrf}` } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' })
      }
      // requestUrl stays the default transport (Obsidian's network stack, proxy support).
      // Only once this site has proven to reject writes as XSRF do we switch to Node.
      if (nodeTransportBases.has(this.base)) {
        const https = await loadHttps()
        if (https) {
          try {
            return await nodeRequest(https, url, method, headers, payload)
          } catch (e) {
            console.warn('[PM] Jira: node https request failed, falling back to requestUrl', e)
          }
        }
      }
      const res = await requestUrl({ url, method, headers, body: payload, throw: false })
      return { status: res.status, text: res.text, headers: res.headers }
    }

    let res = await send()
    // Learn (or refresh) the XSRF token from any response that issues one.
    const issued = readXsrfCookie(res.headers)
    if (issued) xsrfByBase.set(this.base, issued)

    // Rejected as XSRF: echoing the token is enough for some tenants; when it isn't, the
    // request is being seen as browser traffic (Electron attaches the session's cookies),
    // so escalate this site to the cookie-free Node transport. One retry either way.
    if (res.status === 403 && /XSRF check failed/i.test(res.text ?? '')) {
      logApi(method, url, body, res.status, res.text, res.headers)
      // Only a real (https) site can be behind Electron's cookie jar; the localhost mock
      // speaks plain http and just needs the retry.
      if (!issued && url.startsWith('https://') && !nodeTransportBases.has(this.base)) {
        nodeTransportBases.add(this.base)
        console.warn(`[PM] Jira: ${this.base} rejects writes as XSRF — switching to the direct Node transport.`)
      }
      res = await send()
    }
    const ok = res.status >= 200 && res.status < 300
    logApi(method, this.base + path, body, res.status, res.text, res.headers)
    // NB: don't touch res.json — in real Obsidian it's a getter that JSON.parses
    // and throws on an empty body (204/empty 200, e.g. transitions, PUT edits,
    // property writes). Parse res.text defensively instead.
    return { status: res.status, data: ok ? parseJson(res.text) : null }
  }

  /** Verify credentials; returns the display name on success. */
  async testConnection(): Promise<{ ok: boolean; user?: string; error?: string }> {
    const { status, data } = await this.req('GET', '/myself')
    if (status >= 200 && status < 300) {
      return { ok: true, user: (data as { displayName?: string } | null)?.displayName }
    }
    if (status === 401 || status === 403) {
      return { ok: false, error: 'Authentication failed (check email + API token).' }
    }
    return { ok: false, error: `JIRA returned HTTP ${status}.` }
  }

  /**
   * Which of the named project permissions the token's account actually holds. Answers
   * "can this token create issues here?" without attempting a write — the decisive check
   * when creates fail with 403 while reads succeed (read-only/scoped token, or a missing
   * project grant). Returns null when the probe itself couldn't run.
   */
  async myPermissions(projectKey: string, permissions: string[]): Promise<Record<string, boolean> | null> {
    const query = `?projectKey=${encodeURIComponent(projectKey)}&permissions=${encodeURIComponent(permissions.join(','))}`
    const { status, data } = await this.req('GET', `/mypermissions${query}`)
    if (status < 200 || status >= 300) return null
    const raw = (data as { permissions?: Record<string, { havePermission?: boolean }> } | null)?.permissions ?? {}
    const out: Record<string, boolean> = {}
    for (const p of permissions) out[p] = Boolean(raw[p]?.havePermission)
    return out
  }

  // ── Metadata discovery ─────────────────────────────────────────────────────────

  /**
   * Discover the "Start date" custom-field id via createmeta (cached per base once found).
   * Returns '' when the project has no such field.
   *
   * Every issue type is probed, not just the first: the field can be on some create
   * screens and not others, and settling for the first type silently disabled start-date
   * sync for the whole project. A miss is deliberately NOT cached, so a later sync retries
   * rather than being wrong for the rest of the session.
   */
  async startFieldId(epicKey: string): Promise<string> {
    if (this.startField) return this.startField
    const cached = startFieldByBase.get(this.base)
    if (cached) return (this.startField = cached)
    const project = projectKeyOf(epicKey)

    // createmeta first — it's project-scoped, so it can't pick a same-named field that
    // isn't on this project's screens. Cloud has shipped more than one envelope for these
    // pages (`values` / `issueTypes` / `fields`), so read whichever came back.
    const types = (await this.req('GET', `/issue/createmeta/${encodeURIComponent(project)}/issuetypes`)).data
    for (const t of listOf<{ id?: string }>(types, 'issueTypes')) {
      if (!t.id) continue
      const meta = (
        await this.req('GET', `/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(t.id)}`)
      ).data
      const start = listOf<{ fieldId?: string; key?: string; name?: string }>(meta, 'fields').find(
        (f) => (f.name ?? '').toLowerCase() === 'start date'
      )
      const id = start?.fieldId ?? start?.key
      if (id) return this.rememberStartField(id)
    }

    // Fallback: the global field list. Custom-field ids are instance-wide, so matching by
    // name here is still correct — it just can't confirm the field is on a create screen.
    const all = (await this.req('GET', '/field')).data
    const named = listOf<{ id?: string; name?: string; schema?: { type?: string } }>(all, 'fields').find(
      (f) => (f.name ?? '').toLowerCase() === 'start date' && f.schema?.type === 'date'
    )
    if (named?.id) return this.rememberStartField(named.id)

    console.warn(`[PM] Jira: no "Start date" field found on project ${project} — start dates won't sync.`)
    this.startField = ''
    return this.startField
  }

  private rememberStartField(id: string): string {
    this.startField = id
    startFieldByBase.set(this.base, id)
    return id
  }

  /**
   * Issue types with their hierarchy level (Sub-task −1, base 0, Epic 1, Initiative 2, …),
   * for resolving a new issue's type from its parent's level. Cached per client.
   */
  async issueTypes(projectHint?: string): Promise<JiraIssueType[]> {
    const project = projectHint ? projectKeyOf(projectHint) : ''
    const cacheKey = this.base + '|' + project
    const cached = issueTypesByBase.get(cacheKey)
    if (cached) return cached
    // Project-scoped when we know the project. The instance-wide /issuetype list repeats
    // names across projects with DIFFERENT hierarchy levels (every project has its own
    // "Task"/"Epic"), and de-duplicating by name there picked whichever came first — which
    // resolved e.g. Initiative to level 0 and made its children Sub-tasks.
    const parse = (data: unknown): JiraIssueType[] => {
      const seen = new Set<string>()
      return listOf<{ name?: string; hierarchyLevel?: number; subtask?: boolean }>(data, 'issueTypes').flatMap((t) => {
        const name = t.name ?? ''
        if (!name || seen.has(name.toLowerCase())) return []
        seen.add(name.toLowerCase())
        const level = typeof t.hierarchyLevel === 'number' ? t.hierarchyLevel : t.subtask ? -1 : 0
        return [{ name, level }]
      })
    }
    // Fall back on the *parsed* result, not the raw length: some responses list types
    // without names/levels, which would otherwise yield an empty (useless) hierarchy.
    let types = project
      ? parse((await this.req('GET', `/issue/createmeta/${encodeURIComponent(project)}/issuetypes`)).data)
      : []
    if (!types.length) types = parse((await this.req('GET', '/issuetype')).data)
    issueTypesByBase.set(cacheKey, types)
    return types
  }

  /** Statuses available in the epic's project (name + category), for the mapping UI. */
  async projectStatuses(epicKey: string): Promise<{ name: string; category: string; id: string }[]> {
    const { data } = await this.req('GET', `/project/${encodeURIComponent(projectKeyOf(epicKey))}/statuses`)
    const out = new Map<string, { category: string; id: string }>()
    if (Array.isArray(data)) {
      for (const it of data as { statuses?: { id?: string; name?: string; statusCategory?: { name?: string } }[] }[]) {
        for (const s of it.statuses ?? []) {
          if (s?.name) out.set(s.name, { category: s.statusCategory?.name ?? '', id: s.id ?? '' })
        }
      }
    }
    return [...out].map(([name, v]) => ({ name, category: v.category, id: v.id }))
  }

  /**
   * Priorities this project actually accepts, for the mapping UI + outbound writes.
   *
   * A project only accepts the priorities in its priority scheme, which is usually a
   * subset of the instance's list — writing one from outside it fails with "The priority
   * selected is invalid". createmeta reports the per-project allowed values, so ask it
   * first (union across the project's issue types) and fall back to the instance-wide
   * list only when createmeta yields nothing.
   */
  async priorities(projectHint?: string): Promise<{ name: string; id: string }[]> {
    const scoped = projectHint ? await this.projectPriorities(projectKeyOf(projectHint)) : []
    if (scoped.length) return scoped
    const { data } = await this.req('GET', '/priority/search?maxResults=100')
    const page = (data ?? {}) as { values?: { id?: string; name?: string }[] }
    return (page.values ?? []).flatMap((p) => (p.name ? [{ name: p.name, id: p.id ?? '' }] : []))
  }

  /** Allowed `priority` values from createmeta, unioned over the project's issue types. */
  private async projectPriorities(project: string): Promise<{ name: string; id: string }[]> {
    if (!project) return []
    const cached = prioritiesByProject.get(this.base + '|' + project)
    if (cached) return cached
    const types = (await this.req('GET', `/issue/createmeta/${encodeURIComponent(project)}/issuetypes`)).data as {
      values?: { id?: string }[]
    } | null
    const out = new Map<string, string>() // name → id
    for (const t of types?.values ?? []) {
      if (!t.id) continue
      const fields = (
        await this.req('GET', `/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(t.id)}`)
      ).data as { values?: { fieldId?: string; allowedValues?: { id?: string; name?: string }[] }[] } | null
      const field = fields?.values?.find((f) => f.fieldId === 'priority')
      for (const v of field?.allowedValues ?? []) {
        if (v.name && !out.has(v.name)) out.set(v.name, v.id ?? '')
      }
    }
    const list = [...out].map(([name, id]) => ({ name, id }))
    if (list.length) prioritiesByProject.set(this.base + '|' + project, list)
    return list
  }

  /** User autocomplete for the assignee mapping UI. */
  async userPicker(query: string, maxResults = 10): Promise<{ accountId: string; displayName: string }[]> {
    if (!query.trim()) return []
    const { data } = await this.req('GET', `/user/picker?query=${encodeURIComponent(query)}&maxResults=${maxResults}`)
    const page = (data ?? {}) as { users?: { accountId?: string; displayName?: string }[] }
    return (page.users ?? []).flatMap((u) =>
      u.accountId ? [{ accountId: u.accountId, displayName: u.displayName ?? u.accountId }] : []
    )
  }

  // ── Issue reads ─────────────────────────────────────────────────────────────────

  /** The issue fields we read (explicit list — the enhanced search drops *navigable). */
  private searchFields(): string {
    const fields = [
      'summary',
      'status',
      'priority',
      'assignee',
      'duedate',
      'issuetype',
      'parent',
      'issuelinks',
      'updated'
    ]
    if (this.startField) fields.push(this.startField)
    return fields.join(',')
  }

  /**
   * Enhanced JQL search (GET /search/jql) — the current Jira Cloud endpoint; the
   * legacy /search (offset paging, `total`) was deprecated and removed. Pages via
   * an opaque `nextPageToken` until `isLast`.
   */
  private async search(jql: string, maxResults = 100): Promise<JiraIssue[]> {
    const out: JiraIssue[] = []
    let token: string | undefined
    for (;;) {
      // `properties` returns our entity-property bag inline with each issue, so we read
      // the milestone flag from the search result instead of an N+1 GET per issue.
      const q = new URLSearchParams({
        jql,
        fields: this.searchFields(),
        properties: ISSUE_PROP,
        maxResults: String(maxResults)
      })
      if (token) q.set('nextPageToken', token)
      const { data } = await this.req('GET', `/search/jql?${q.toString()}`)
      const page = (data ?? {}) as { issues?: unknown[]; nextPageToken?: string; isLast?: boolean }
      for (const raw of page.issues ?? []) out.push(normalizeIssue(raw, this.startField))
      if (page.isLast || !page.nextPageToken) break
      token = page.nextPageToken
    }
    return out
  }

  async epicChildren(epicKey: string): Promise<JiraIssue[]> {
    return this.search(epicChildrenJql(epicKey))
  }
  async epicUpdatedSince(epicKey: string, sinceJiraTime: string): Promise<JiraIssue[]> {
    return this.search(epicUpdatedSinceJql(epicKey, sinceJiraTime))
  }
  /** Direct children of the given issues by `parent` (sub-items + the unified hierarchy). */
  async subtasksOf(parentKeys: string[]): Promise<JiraIssue[]> {
    if (!parentKeys.length) return []
    return this.search(parentInJql(parentKeys))
  }
  /** Fetch specific issues by key (e.g. locally-dirty tasks whose Jira side may be unchanged). */
  async issuesByKeys(keys: string[]): Promise<JiraIssue[]> {
    if (!keys.length) return []
    return this.search(keyInJql(keys))
  }
  /** Incremental pull: tracked issues + new children, changed since the watermark. */
  async changedInSubtree(trackedKeys: string[], epicKey: string, since: string): Promise<JiraIssue[]> {
    return this.search(subtreeChangedJql(trackedKeys, epicKey, since))
  }
  async getIssue(key: string): Promise<JiraIssue | null> {
    const { data } = await this.req('GET', `/issue/${encodeURIComponent(key)}?fields=*navigable`)
    return data ? normalizeIssue(data, this.startField) : null
  }

  // ── Issue writes ─────────────────────────────────────────────────────────────────

  /** Create an issue; `fields` is the native JIRA create payload. Returns the new key. */
  async createIssue(fields: Record<string, unknown>): Promise<{ key: string } | { error: string }> {
    const { status, data } = await this.req('POST', '/issue', { fields })
    if (status < 200 || status >= 300) return { error: `JIRA returned HTTP ${status}.` }
    const key = (data as { key?: string } | null)?.key
    return key ? { key } : { error: 'JIRA did not return an issue key.' }
  }

  /** Edit an issue's native fields (PUT /issue/{key}). */
  async editIssue(key: string, fields: Record<string, unknown>): Promise<boolean> {
    const { status } = await this.req('PUT', `/issue/${encodeURIComponent(key)}`, { fields })
    return status >= 200 && status < 300
  }

  /** Create a "Blocks" link: `blockedKey` is blocked by `blockerKey` (its predecessor). */
  async createLink(blockedKey: string, blockerKey: string): Promise<boolean> {
    const { status } = await this.req('POST', '/issueLink', {
      type: { name: 'Blocks' },
      inwardIssue: { key: blockedKey }, // "is blocked by"
      outwardIssue: { key: blockerKey } // "blocks"
    })
    return status >= 200 && status < 300
  }

  /** Delete an issue link by its id (DELETE /issueLink/{id}). */
  async deleteLink(linkId: string): Promise<boolean> {
    const { status } = await this.req('DELETE', `/issueLink/${encodeURIComponent(linkId)}`)
    return status >= 200 && status < 300
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const { data } = await this.req('GET', `/issue/${encodeURIComponent(key)}/transitions`)
    return ((data as { transitions?: JiraTransition[] } | null)?.transitions ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      to: { id: t.to?.id ?? '', name: t.to?.name ?? '' }
    }))
  }

  /**
   * Transition an issue to a target status. Matches by status `id` when given (robust
   * against renames / duplicate display names), else by name. Returns success.
   */
  async transitionTo(key: string, statusName: string, statusId?: string): Promise<boolean> {
    const t = (await this.getTransitions(key)).find(
      (x) => (statusId ? x.to.id === statusId : false) || x.to.name.toLowerCase() === statusName.toLowerCase()
    )
    if (!t) return false
    const { status } = await this.req('POST', `/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: t.id }
    })
    return status >= 200 && status < 300
  }

  async getProperty(key: string, propKey: string): Promise<unknown> {
    if (!key) return undefined // an empty key collapses to `/issue/properties/…` (405); never call it
    const { status, data } = await this.req(
      'GET',
      `/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propKey)}`
    )
    if (status < 200 || status >= 300) return undefined
    return (data as { value?: unknown } | null)?.value
  }

  async setProperty(key: string, propKey: string, value: unknown): Promise<boolean> {
    if (!key) return false
    const { status } = await this.req(
      'PUT',
      `/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propKey)}`,
      value
    )
    return status >= 200 && status < 300
  }

  /** Remove an entity property. A 404 (already absent) counts as success — the goal is "gone". */
  async deleteProperty(key: string, propKey: string): Promise<boolean> {
    if (!key) return false
    const { status } = await this.req(
      'DELETE',
      `/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propKey)}`
    )
    return (status >= 200 && status < 300) || status === 404
  }
}
