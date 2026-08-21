import { parseLinktext, setTooltip } from 'obsidian'
import { stringToColor } from '../../utils'

export function displayName(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/^\[\[([^\]]+)\]\]$/)
  if (!m) return trimmed
  const inner = m[1]
  const pipe = inner.indexOf('|')
  if (pipe >= 0) {
    const alias = inner.slice(pipe + 1).trim()
    if (alias) return alias
  }
  const target = pipe >= 0 ? inner.slice(0, pipe) : inner
  const { path } = parseLinktext(target)
  const base = path.split('/').pop() ?? path
  return (base.endsWith('.md') ? base.slice(0, -3) : base).trim()
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const raw = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return raw.toUpperCase()
}

/** How many letters to take from the first and last name at each widening step. */
const WIDEN: readonly [number, number][] = [
  [1, 1],
  [2, 1],
  [2, 2],
  [3, 2],
  [3, 3],
  [4, 3],
  [4, 4],
  [6, 6]
]

/** `[first, last]` letters of a name, capitalised: ("Jay Dean", 2, 2) → "JaDe". */
function initialsAt(name: string, first: number, last: number): string {
  const parts = displayName(name).trim().split(/\s+/).filter(Boolean)
  const cap = (word: string, n: number): string =>
    word.slice(0, 1).toUpperCase() + word.slice(1, Math.max(1, n)).toLowerCase()
  if (parts.length < 2) return cap(parts[0] ?? name, first + last)
  return cap(parts[0], first) + cap(parts[parts.length - 1], last)
}

/**
 * Initials for a set of names, widened just far enough that no two collide.
 *
 * Two-letter initials stop telling people apart as soon as a team has a "Jay Dean" and a
 * "Jo Delorie" — both render "JD". Colliding names take another letter until they're
 * distinct: JaD / JoD. Add a "Jane Dorethy" and that trio widens again (JaDe / JaDo)
 * while JoD, already unambiguous, stays short.
 *
 * Uniqueness is a property of the *set*, so this has to be resolved for a whole roster
 * rather than one name at a time — and the same person can render differently in a
 * different view. The rule is always "unique within what you're looking at".
 */
export function initialsRoster(names: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>()
  // Deduplicate by display name: two spellings of one person aren't a collision to solve.
  let pending = [...new Set([...names].map((n) => n.trim()).filter(Boolean))]

  for (const [first, last] of WIDEN) {
    if (!pending.length) break
    const groups = new Map<string, string[]>()
    for (const name of pending) {
      const key = initialsAt(name, first, last)
      groups.set(key, [...(groups.get(key) ?? []), name])
    }
    const stillClashing: string[] = []
    for (const [initials, group] of groups) {
      // One claimant, and nobody shorter already took it → settled.
      if (group.length === 1 && !taken.has(initials)) {
        set(out, group[0], initials)
        taken.add(initials)
      } else {
        stillClashing.push(...group)
      }
    }
    pending = stillClashing
  }
  // Anything still colliding at full width can't be told apart by letters; leave it.
  for (const name of pending) set(out, name, initialsAt(name, 6, 6))
  return out
}

/**
 * Key the result by both the stored name and its display form. Assignees may be stored as
 * "[[Ada Lovelace]]" wikilinks, and callers look up by either — the gantt maps to display
 * names before drawing, the table passes the raw value.
 */
function set(out: Map<string, string>, name: string, initials: string): void {
  out.set(name, initials)
  const display = displayName(name)
  if (display !== name) out.set(display, initials)
}

export class Avatar {
  el: HTMLSpanElement

  constructor(parentEl: HTMLElement) {
    this.el = parentEl.createSpan({ cls: 'pm-avatar' })
  }

  /**
   * `roster` comes from {@link initialsRoster}: initials made unique across everyone the
   * view shows. Without one, initials fall back to two letters and may collide.
   */
  setName(name: string, roster?: Map<string, string>): this {
    const display = displayName(name)
    this.el.setText(roster?.get(display) ?? roster?.get(name) ?? initialsFor(display))
    this.el.style.background = stringToColor(display)
    setTooltip(this.el, display)
    return this
  }

  setSize(size: 'md' | 'sm'): this {
    this.el.toggleClass('pm-avatar--sm', size === 'sm')
    return this
  }
}
