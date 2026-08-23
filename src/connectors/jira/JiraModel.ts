import type { PriorityConfig, StatusConfig, TaskPriority, TaskStatus } from '../../types'
import type { JiraValueMap } from './types'
import { adfToMarkdown, type AdfStash } from './adf'
import { ISSUE_PROP } from './types'

/** Normalized JIRA issue — the subset of fields we map onto tasks. */
export interface JiraIssue {
  key: string
  summary: string
  status: string
  /** JIRA status category name: "To Do" | "In Progress" | "Done". */
  statusCategory: string
  priority: string
  assigneeAccountId: string | null
  assigneeName: string | null
  start: string | null // YYYY-MM-DD. JIRA has no built-in start date — a custom field (here: fields.start)
  due: string | null // YYYY-MM-DD (JIRA built-in duedate)
  updated: string // ISO timestamp from JIRA
  parentKey: string | null
  issueType: string
  isSubtask: boolean
  /** Our `obsidian-pm` entity property's milestone flag, read inline from search. */
  milestone: boolean
  /**
   * The description as Markdown. Converted here, where every other field is normalised,
   * so the rest of the connector never has to know Jira stores it as an ADF tree.
   */
  description: string
  /**
   * Description nodes Markdown can't hold, by the token the text references. Carried so a
   * push can restore the originals instead of writing the words describing them.
   */
  descriptionStash: AdfStash
  /** Keys of issues this one "is blocked by" (its predecessors). */
  blockedBy: string[]
  /** The "is blocked by" links with their JIRA link ids, for reconciliation (add/remove). */
  blockLinks: { id: string; key: string }[]
}

/** The shape of a raw JIRA REST issue, narrowed to the fields we read. */
interface RawIssue {
  key?: string
  /** Entity properties, returned inline when the search requests `properties=`. */
  properties?: Record<string, unknown>
  fields?: {
    summary?: string
    /** ADF document on the v3 API; a plain string on v2 and on un-migrated issues. */
    description?: unknown
    status?: { name?: string; statusCategory?: { name?: string } }
    priority?: { name?: string }
    assignee?: { accountId?: string; displayName?: string } | null
    duedate?: string | null
    updated?: string
    parent?: { key?: string }
    issuetype?: { name?: string; subtask?: boolean }
    issuelinks?: { id?: string; type?: { inward?: string }; inwardIssue?: { key?: string } }[]
    [customField: string]: unknown
  }
}

/** `startFieldId` is the instance's "Start date" custom-field id (start has no built-in field). */
export function normalizeIssue(raw: unknown, startFieldId?: string): JiraIssue {
  const r = (raw ?? {}) as RawIssue
  const f = r.fields ?? {}
  const blockedBy: string[] = []
  const blockLinks: { id: string; key: string }[] = []
  for (const link of f.issuelinks ?? []) {
    if (link?.type?.inward === 'is blocked by' && link.inwardIssue?.key) {
      blockedBy.push(link.inwardIssue.key)
      if (link.id) blockLinks.push({ id: link.id, key: link.inwardIssue.key })
    }
  }
  const start = startFieldId ? (f[startFieldId] as string | null | undefined) : undefined
  const milestone = (r.properties?.[ISSUE_PROP] as { milestone?: boolean } | undefined)?.milestone === true
  const descriptionStash: AdfStash = {}
  return {
    key: r.key ?? '',
    summary: f.summary ?? '',
    description: adfToMarkdown(f.description, descriptionStash),
    descriptionStash,
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.name ?? '',
    priority: f.priority?.name ?? '',
    assigneeAccountId: f.assignee?.accountId ?? null,
    assigneeName: f.assignee?.displayName ?? null,
    start: start ?? null,
    due: f.duedate ?? null,
    updated: f.updated ?? '',
    parentKey: f.parent?.key ?? null,
    issueType: f.issuetype?.name ?? '',
    // Real JIRA always sends the boolean; fall back to the type name for robustness.
    isSubtask: f.issuetype?.subtask === true || /sub-?task/i.test(f.issuetype?.name ?? ''),
    milestone,
    blockedBy,
    blockLinks
  }
}

/** Project key from an issue/epic key: "DEMO-1234" → "DEMO". */
export function projectKeyOf(issueKey: string): string {
  const dash = issueKey.lastIndexOf('-')
  return dash > 0 ? issueKey.slice(0, dash) : issueKey
}

/** JQL matching the direct children of an epic (covers team- and company-managed). */
export function epicChildrenJql(epicKey: string): string {
  const k = epicKey.replace(/"/g, '')
  return `(parent = "${k}" OR "Epic Link" = "${k}") ORDER BY created ASC`
}

/** JQL for issues under an epic updated since a watermark (incremental poll). */
export function epicUpdatedSinceJql(epicKey: string, sinceJiraTime: string): string {
  const k = epicKey.replace(/"/g, '')
  return `(parent = "${k}" OR "Epic Link" = "${k}") AND updated > "${sinceJiraTime}" ORDER BY updated ASC`
}

/** JQL for the sub-tasks of the given parent issues. */
export function parentInJql(parentKeys: string[]): string {
  const list = parentKeys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')
  return `parent in (${list}) ORDER BY created ASC`
}

const quoteKeys = (keys: string[]): string => keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')

/** JQL for the given issue keys. */
export function keyInJql(keys: string[]): string {
  return `key in (${quoteKeys(keys)}) ORDER BY created ASC`
}

/**
 * Incremental JQL for a periodic tick: tracked issues OR direct children of any tracked
 * issue/the epic (catches new children), changed since the watermark. Subtree-scoped via
 * the known local keys, so it never scans the whole project.
 */
export function subtreeChangedJql(trackedKeys: string[], epicKey: string, since: string): string {
  const tracked = quoteKeys(trackedKeys)
  const parents = quoteKeys([...trackedKeys, epicKey])
  const scope = tracked ? `(key in (${tracked}) OR parent in (${parents}))` : `parent in (${parents})`
  const time = since ? ` AND updated > "${toJqlTime(since)}"` : ''
  return `${scope}${time} ORDER BY updated ASC`
}

// ─── Issue-type hierarchy (for create: a child is one level below its parent) ───

/** A JIRA issue type with its hierarchy level: Sub-task −1, Story/Task 0, Epic 1, Initiative 2, … */
export interface JiraIssueType {
  name: string
  level: number
}

/** The hierarchy level of a named issue type (e.g. the configured root), or undefined. */
export function levelOfType(types: JiraIssueType[], name: string): number | undefined {
  return types.find((t) => t.name.toLowerCase() === name.toLowerCase())?.level
}

/**
 * The issue-type name to create at a hierarchy level. When several share a level (e.g.
 * Task/Story/Bug at 0) prefer the common base names; otherwise take the first. Returns
 * null when no type exists at that level (e.g. below Sub-task → too deep to create).
 */
export function typeForLevel(types: JiraIssueType[], level: number): string | null {
  const at = types.filter((t) => t.level === level)
  if (!at.length) return null
  const preferred = ['Task', 'Story', 'Bug', 'Epic', 'Sub-task', 'Subtask']
  for (const name of preferred) {
    const hit = at.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (hit) return hit.name
  }
  return at[0].name
}

/** Convert a JIRA `updated` ISO timestamp to the "yyyy-MM-dd HH:mm" form JQL accepts. */
export function toJqlTime(iso: string): string {
  // 2026-04-20T10:00:00.000+0000 → 2026-04-20 10:00
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : iso
}

// ─── Value mapping (string match, N→1, one outbound canonical) ────────────────

const eq = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Map a JIRA status/priority name to our id (case-insensitive exact match), else fallback. */
export function mapInbound(entries: JiraValueMap[] | undefined, jiraValue: string, fallback: string): string {
  for (const e of entries ?? []) {
    if (e.jira && eq(e.jira, jiraValue)) return e.target
  }
  return fallback
}

/**
 * The mapping rule to push for one of our ids: the entry flagged `outbound`, else
 * the first entry for that target. Undefined when nothing maps to it. Callers read
 * `.id` (preferred JIRA-side identifier) with `.jira` (name) as the fallback.
 */
export function mapOutboundEntry(entries: JiraValueMap[] | undefined, targetId: string): JiraValueMap | undefined {
  const group = (entries ?? []).filter((e) => e.jira && e.target === targetId)
  return group.find((e) => e.outbound) ?? group[0]
}

/** The JIRA value name to push for one of our ids (see {@link mapOutboundEntry}). */
export function mapOutbound(entries: JiraValueMap[] | undefined, targetId: string): string | undefined {
  return mapOutboundEntry(entries, targetId)?.jira
}

/**
 * Decide a synced task's status on an inbound pull (smart conflict), purely from
 * local signals — no JIRA-side desired state:
 *   - already agree (incl. our push landed) → in sync
 *   - we didn't change locally this cycle → JIRA wins (teammate update)
 *   - we changed locally but JIRA doesn't reflect it → limbo (keep local, flag)
 *
 * `localChanged` = the task was in the outbound dirty set this cycle.
 */
export function reconcileStatus(args: {
  issueStatus: string // JIRA's current status name (cached for the limbo UI)
  actualPMStatus: string // mapInbound(issueStatus)
  localPMStatus: string // the task's current status id
  localChanged: boolean
}): { status: string; reconciled: boolean; jiraStatus: string } {
  const { issueStatus, actualPMStatus, localPMStatus, localChanged } = args
  if (actualPMStatus === localPMStatus || !localChanged) {
    return { status: actualPMStatus, reconciled: true, jiraStatus: issueStatus }
  }
  return { status: localPMStatus, reconciled: false, jiraStatus: issueStatus }
}

/** Guess which of our statuses a JIRA status maps to, by category + name heuristics. */
function guessStatus(js: { name: string; category: string }, statuses: StatusConfig[]): TaskStatus {
  const firstComplete = statuses.find((s) => s.complete)?.id ?? statuses[statuses.length - 1]?.id ?? 'done'
  const firstOpen = statuses.find((s) => !s.complete)?.id ?? statuses[0]?.id ?? 'todo'
  const byId = (id: string) => statuses.find((s) => s.id === id)?.id
  const cat = js.category.toLowerCase()
  const name = js.name.toLowerCase()
  if (cat === 'done') return firstComplete
  if (name.includes('review')) return byId('review') ?? byId('in-progress') ?? firstOpen
  if (cat === 'in progress') return byId('in-progress') ?? firstOpen
  return byId('todo') ?? firstOpen
}

/** Guess which of our priorities a JIRA priority name maps to. */
function guessPriority(name: string, priorities: PriorityConfig[]): TaskPriority {
  const fallback = priorities[0]?.id ?? 'medium'
  const pick = (id: TaskPriority): TaskPriority => (priorities.some((p) => p.id === id) ? id : fallback)
  const n = name.toLowerCase()
  if (/highest|blocker|critical|urgent/.test(n)) return pick('critical')
  if (/high|major/.test(n)) return pick('high')
  if (/low|minor|trivial/.test(n)) return pick('low')
  return pick('medium')
}

const hasOutboundFor = (entries: JiraValueMap[], target: string): boolean =>
  entries.some((e) => e.target === target && e.outbound)

/**
 * Merge discovered JIRA statuses into the existing map: keep every rule, and add a
 * string-match rule (guessed target) for each JIRA status not already present. The
 * first rule for a given target becomes its outbound canonical. Pre-fills the UI.
 */
export function mergeStatusMap(
  existing: JiraValueMap[],
  jiraStatuses: { name: string; category: string; id?: string }[],
  statuses: StatusConfig[]
): JiraValueMap[] {
  const out = [...existing]
  for (const js of jiraStatuses) {
    if (!js.name) continue
    const found = out.find((e) => eq(e.jira, js.name))
    if (found) {
      if (js.id && !found.id) found.id = js.id // backfill the id onto a legacy (id-less) rule
      continue
    }
    const target = guessStatus(js, statuses)
    out.push({ jira: js.name, target, outbound: !hasOutboundFor(out, target), ...(js.id ? { id: js.id } : {}) })
  }
  return out
}

/** Like {@link mergeStatusMap} but for JIRA priorities (name + id). */
export function mergePriorityMap(
  existing: JiraValueMap[],
  jiraPriorities: { name: string; id?: string }[],
  priorities: PriorityConfig[]
): JiraValueMap[] {
  const out = [...existing]
  for (const jp of jiraPriorities) {
    if (!jp.name) continue
    const found = out.find((e) => eq(e.jira, jp.name))
    if (found) {
      if (jp.id && !found.id) found.id = jp.id
      continue
    }
    const target = guessPriority(jp.name, priorities)
    out.push({ jira: jp.name, target, outbound: !hasOutboundFor(out, target), ...(jp.id ? { id: jp.id } : {}) })
  }
  return out
}
