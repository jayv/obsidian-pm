/**
 * Pure Obsidian-side decision logic for the JIRA connector — the glue between the
 * UI (task checkbox, sync tick, limbo resolution, disconnect) and the sync engine.
 * Kept free of DOM/obsidian imports so every user interaction is unit-testable.
 */
import type { Task } from '../../types'
import type { JiraAssignee, JiraProjectConfig, JiraValueMap } from './types'
import { JIRA_ID, ensureTaskExt, taskExt } from './types'

/** New tasks in a JIRA-enabled project default to synced (the checkbox starts checked). */
export function defaultNewTaskSync(task: Task, isNew: boolean): void {
  if (isNew && !taskExt(task).key && taskExt(task).sync === undefined) ensureTaskExt(task).sync = true
}

/**
 * The checked state of a task's "sync with Jira" checkbox: new tasks and linked
 * tasks (with a key) are checked; existing tasks otherwise follow the opt-in flag.
 */
export function isLinkChecked(task: Task, isNew: boolean): boolean {
  const ext = taskExt(task)
  return isNew || Boolean(ext.key) || ext.sync === true
}

/** Opt a task into sync (checkbox checked). */
export function linkTask(task: Task): void {
  ensureTaskExt(task).sync = true
}

/**
 * Opt a task out (checkbox unchecked): drop its JIRA frontmatter and add its key to
 * the ignore list so a future sync won't recreate or re-import it.
 */
export function unlinkTask(task: Task, cfg: JiraProjectConfig): void {
  const key = taskExt(task).key
  if (key && !cfg.ignoredKeys.includes(key)) cfg.ignoredKeys.push(key)
  if (task.ext) Reflect.deleteProperty(task.ext, JIRA_ID)
}

/**
 * A synced task was deleted in Obsidian: add its key to the ignore list so the next
 * sync leaves the Jira issue alone and doesn't re-offer it for import. We never delete
 * the Jira issue. No-op for an unlinked task (no key).
 */
export function ignoreOnDelete(cfg: JiraProjectConfig, task: Task): void {
  const key = taskExt(task).key
  if (key && !cfg.ignoredKeys.includes(key)) cfg.ignoredKeys.push(key)
}

/** Whether the interval sync is due (now − lastSyncAt ≥ interval). */
export function dueForSync(cfg: JiraProjectConfig, now: number): boolean {
  const intervalMs = (cfg.syncIntervalMin ?? 5) * 60_000
  const last = cfg.lastSyncAt ? Date.parse(cfg.lastSyncAt) : 0
  return now - last >= intervalMs
}

/** Queue a changed task for the next outbound push — only synced tasks in enabled projects. */
export function queueDirty(cfg: JiraProjectConfig, task: Task): void {
  if (!cfg.enabled || !taskExt(task).sync) return
  cfg.dirtyQueue = cfg.dirtyQueue ?? []
  if (!cfg.dirtyQueue.includes(task.id)) cfg.dirtyQueue.push(task.id)
}

/** Strip the whole jira block from a task ext (used by Disconnect); undefined if empty after. */
export function stripJira(ext: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!ext) return undefined
  const rest = { ...ext }
  Reflect.deleteProperty(rest, JIRA_ID)
  return Object.keys(rest).length ? rest : undefined
}

// ── Mapping-panel logic (the "→ Jira" radio + assignee picker) ─────────────────

/** Make `entry` the sole outbound (write-back) rule for its target — exclusive per target. */
export function setOutbound(entries: JiraValueMap[], entry: JiraValueMap): void {
  for (const e of entries) {
    if (e.target === entry.target) e.outbound = e === entry
  }
}

/**
 * Upsert a team member's JIRA-user mapping by member name. An empty `jiraUser`
 * removes the row; otherwise it updates an existing row or appends a new one.
 */
/**
 * Move a mapping when its team member is renamed. The map is keyed by the member's name,
 * so without this the renamed member reads as brand-new and unmapped, and assignment sync
 * silently stops for them.
 *
 * An empty `to` (the member was cleared) drops the entry. Renaming onto a member who
 * already has a mapping keeps theirs — the surviving member's own mapping is the better
 * of the two — and drops the row being renamed away.
 */
export function renameAssigneeMapping(map: JiraAssignee[], from: string, to: string): void {
  const at = map.findIndex((e) => e.name === from)
  if (at < 0) return
  if (!to || map.some((e) => e.name === to)) map.splice(at, 1)
  else map[at].name = to
}

export function upsertAssigneeMapping(
  map: JiraAssignee[],
  member: string,
  jiraUser: string,
  jiraDisplay?: string
): void {
  const idx = map.findIndex((e) => e.name === member)
  if (!jiraUser) {
    if (idx >= 0) map.splice(idx, 1)
  } else if (idx >= 0) {
    map[idx].jiraUser = jiraUser
    map[idx].jiraDisplay = jiraDisplay
  } else {
    map.push({ name: member, jiraUser, jiraDisplay })
  }
}
