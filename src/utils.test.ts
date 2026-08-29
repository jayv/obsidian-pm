import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatDateShort, formatDateLong, priorityRank } from './utils'
import { DEFAULT_PRIORITIES, UBER_FILTER_KEY, isVirtualFilterKey, type TaskPriority } from './types'

describe('date formatters use the local calendar date', () => {
  // Pin a negative-offset timezone: a bare YYYY-MM-DD parsed as UTC midnight would
  // render the previous day there — the exact condition the formatters must survive.
  beforeAll(() => vi.stubEnv('TZ', 'America/Los_Angeles'))
  afterAll(() => vi.unstubAllEnvs())

  it('the test environment really is in a negative-offset zone', () => {
    // UTC midnight of the 29th is the 28th in LA — guards that the case below is meaningful.
    expect(new Date('2026-06-29').getDate()).toBe(28)
  })

  it('renders a bare YYYY-MM-DD without a timezone off-by-one', () => {
    expect(formatDateShort('2026-06-29')).toBe('Jun 29')
    expect(formatDateLong('2026-06-29')).toBe('Jun 29, 26')
  })
})

describe('priorityRank', () => {
  const priorities = DEFAULT_PRIORITIES

  it('ranks most urgent first, following the configured order', () => {
    const sorted = ['low', 'critical', 'medium', 'high'].sort(
      (a, b) => priorityRank(priorities, a as TaskPriority) - priorityRank(priorities, b as TaskPriority)
    )
    expect(sorted).toEqual(['critical', 'high', 'medium', 'low'])
  })

  it('follows a reordered priority list rather than a hardcoded order', () => {
    const reversed = [...priorities].reverse()
    expect(priorityRank(reversed, 'low')).toBeLessThan(priorityRank(reversed, 'critical'))
  })

  it('sorts an unknown priority last', () => {
    expect(priorityRank(priorities, 'nonexistent' as TaskPriority)).toBeGreaterThan(priorityRank(priorities, 'low'))
  })
})

/*
 * The all-projects timeline has no note, so its filter and saved views are keyed by a
 * synthetic `::all-projects` rather than a path. Startup prunes projectFilters entries
 * whose path no longer resolves to a file — and that key never resolves, so it was
 * deleted on every launch: the filter looked like it saved, then came back empty.
 */
describe('virtual filter keys', () => {
  it('recognises the all-projects key as virtual, and real paths as not', () => {
    expect(isVirtualFilterKey(UBER_FILTER_KEY)).toBe(true)
    expect(isVirtualFilterKey('Projects/Athlon.md')).toBe(false)
  })

  it('survives the stale-filter prune, while a deleted project does not', () => {
    // Mirrors cleanupStaleProjectFilters: keep a key when it is virtual OR still a file.
    const files = new Set(['Projects/Alive.md'])
    const keep = (key: string): boolean => isVirtualFilterKey(key) || files.has(key)
    const kept = ['Projects/Alive.md', 'Projects/Deleted.md', UBER_FILTER_KEY].filter(keep)
    expect(kept).toEqual(['Projects/Alive.md', UBER_FILTER_KEY])
  })
})
