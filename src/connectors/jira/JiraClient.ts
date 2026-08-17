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
  resHeaders?: Record<string, string>
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
    const res = await requestUrl({
      url: this.base + path,
      method,
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        // Jira rejects writes it believes came from a browser form ("XSRF check failed",
        // 403) — Obsidian is Electron, so an Atlassian session cookie can ride along and
        // trigger it even with Basic auth. This opts out; standard for REST clients.
        'X-Atlassian-Token': 'no-check',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false
    })
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

  // ── Metadata discovery ─────────────────────────────────────────────────────────

  /** Discover the "Start date" custom-field id via createmeta (cached per base). Returns '' if absent. */
  async startFieldId(epicKey: string): Promise<string> {
    if (this.startField !== undefined) return this.startField
    const cached = startFieldByBase.get(this.base)
    if (cached !== undefined) return (this.startField = cached)
    this.startField = ''
    const project = projectKeyOf(epicKey)
    const types = (await this.req('GET', `/issue/createmeta/${encodeURIComponent(project)}/issuetypes`)).data as {
      values?: { id?: string }[]
    } | null
    const typeId = types?.values?.[0]?.id
    if (!typeId) return this.startField
    const fields = (
      await this.req('GET', `/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(typeId)}`)
    ).data as { values?: { fieldId?: string; name?: string }[] } | null
    const start = fields?.values?.find((f) => (f.name ?? '').toLowerCase() === 'start date')
    this.startField = start?.fieldId ?? ''
    startFieldByBase.set(this.base, this.startField)
    return this.startField
  }

  /**
   * Issue types with their hierarchy level (Sub-task −1, base 0, Epic 1, Initiative 2, …),
   * for resolving a new issue's type from its parent's level. Cached per client.
   */
  async issueTypes(): Promise<JiraIssueType[]> {
    const cached = issueTypesByBase.get(this.base)
    if (cached) return cached
    const { data } = await this.req('GET', '/issuetype')
    const raw = Array.isArray(data) ? (data as { name?: string; hierarchyLevel?: number; subtask?: boolean }[]) : []
    const seen = new Set<string>()
    const types = raw.flatMap((t) => {
      const name = t.name ?? ''
      if (!name || seen.has(name.toLowerCase())) return []
      seen.add(name.toLowerCase())
      const level = typeof t.hierarchyLevel === 'number' ? t.hierarchyLevel : t.subtask ? -1 : 0
      return [{ name, level }]
    })
    issueTypesByBase.set(this.base, types)
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

  /** Priorities available in this JIRA instance (name + id), for the mapping UI + outbound writes. */
  async priorities(): Promise<{ name: string; id: string }[]> {
    const { data } = await this.req('GET', '/priority/search?maxResults=100')
    const page = (data ?? {}) as { values?: { id?: string; name?: string }[] }
    return (page.values ?? []).flatMap((p) => (p.name ? [{ name: p.name, id: p.id ?? '' }] : []))
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
