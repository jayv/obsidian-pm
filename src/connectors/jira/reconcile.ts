/**
 * Three-way merge for a task's synced fields, using the last-synced `shadow` as the
 * common base. For each field:
 *   - mine == theirs            → already agree (nothing to do)
 *   - mine == base (we didn't change it)   → ADOPT JIRA's value
 *   - theirs == base (they didn't change)  → PUSH our value
 *   - otherwise (both changed differently) → CONFLICT
 *
 * This replaces the old status-only reconcile: every field gets the same treatment,
 * so a one-sided change never clobbers the other side and a genuine clash surfaces.
 */
import type { JiraShadow } from './types'

export type SyncField = keyof JiraShadow // title | status | priority | start | due | assignees | milestone | blockedBy

export const SYNC_FIELDS: SyncField[] = [
  'title',
  'status',
  'priority',
  'start',
  'due',
  'assignees',
  'milestone',
  'blockedBy'
]

export interface FieldConflict {
  field: SyncField
  mine: JiraShadow[SyncField]
  theirs: JiraShadow[SyncField]
}

export interface ThreeWay {
  push: SyncField[] // local changed, JIRA didn't — safe to write to JIRA
  adopt: SyncField[] // JIRA changed, local didn't — safe to take into Obsidian
  conflicts: FieldConflict[] // both changed differently — needs resolution
}

/** Value equality, treating assignee arrays as unordered sets. */
export function fieldsEqual(a: JiraShadow[SyncField], b: JiraShadow[SyncField]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x) => b.includes(x))
  return a === b
}

/** A differing field for the conflict resolver, with its default resolution pick. */
export interface FieldDiff {
  field: SyncField
  /** Default = adopt JIRA's value iff we didn't change it locally (mine == base). */
  defaultTakeTheirs: boolean
}

/**
 * The fields where local (`mine`) and JIRA (`theirs`) disagree — what the conflict
 * resolver renders. The default pick adopts JIRA's value for fields we didn't touch
 * locally (`mine == base`) and keeps ours otherwise; without a base it keeps ours.
 */
export function conflictFields(mine: JiraShadow, base: JiraShadow | undefined, theirs: JiraShadow): FieldDiff[] {
  const out: FieldDiff[] = []
  for (const f of SYNC_FIELDS) {
    if (fieldsEqual(mine[f], theirs[f])) continue
    out.push({ field: f, defaultTakeTheirs: base !== undefined && fieldsEqual(mine[f], base[f]) })
  }
  return out
}

export function threeWay(mine: JiraShadow, base: JiraShadow, theirs: JiraShadow): ThreeWay {
  const push: SyncField[] = []
  const adopt: SyncField[] = []
  const conflicts: FieldConflict[] = []
  for (const f of SYNC_FIELDS) {
    const m = mine[f]
    const b = base[f]
    const t = theirs[f]
    if (fieldsEqual(m, t)) continue
    if (fieldsEqual(m, b)) adopt.push(f)
    else if (fieldsEqual(t, b)) push.push(f)
    else conflicts.push({ field: f, mine: m, theirs: t })
  }
  return { push, adopt, conflicts }
}
