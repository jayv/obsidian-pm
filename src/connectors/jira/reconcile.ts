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
import { adfToMarkdown, markdownToAdf } from './adf'

export type SyncField = keyof JiraShadow // title | status | priority | start | due | assignees | milestone | blockedBy

export const SYNC_FIELDS: SyncField[] = [
  'title',
  'status',
  'priority',
  'start',
  'due',
  'assignees',
  'milestone',
  'description',
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
export function fieldsEqual(a: JiraShadow[SyncField], b: JiraShadow[SyncField], field?: SyncField): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x) => b.includes(x))
  // A description round-trips through ADF, and that isn't the identity function: "- a" may
  // come home as "* a". Comparing the canonical form means a formatting difference the
  // conversion introduced isn't mistaken for someone's edit — which would otherwise
  // rewrite the note on every sync after every push.
  if (field === 'description' && typeof a === 'string' && typeof b === 'string') {
    return a === b || canonicalDescription(a) === canonicalDescription(b)
  }
  return a === b
}

/** What a description becomes after a trip through Jira's format and back. */
export function canonicalDescription(md: string): string {
  return adfToMarkdown(markdownToAdf(md))
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
    if (fieldsEqual(mine[f], theirs[f], f)) continue
    out.push({ field: f, defaultTakeTheirs: base !== undefined && fieldsEqual(mine[f], base[f], f) })
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
    if (fieldsEqual(m, t, f)) continue
    if (fieldsEqual(m, b, f)) adopt.push(f)
    else if (fieldsEqual(t, b, f)) push.push(f)
    else conflicts.push({ field: f, mine: m, theirs: t })
  }
  return { push, adopt, conflicts }
}
