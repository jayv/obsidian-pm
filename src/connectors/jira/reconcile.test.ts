import { describe, expect, it } from 'vitest'
import type { JiraShadow } from './types'
import { conflictFields, threeWay } from './reconcile'

const base: JiraShadow = {
  title: 'T',
  status: 'todo',
  priority: 'medium',
  start: '2026-01-01',
  due: '',
  assignees: ['Alice'],
  milestone: false,
  description: '',
  blockedBy: []
}
const snap = (over: Partial<JiraShadow> = {}): JiraShadow => ({ ...base, ...over })

describe('threeWay merge (single shadow base)', () => {
  it('does nothing when both sides match the base', () => {
    const r = threeWay(snap(), base, snap())
    expect(r).toEqual({ push: [], adopt: [], conflicts: [] })
  })

  it('pushes a field only the local side changed', () => {
    const r = threeWay(snap({ status: 'done' }), base, snap())
    expect(r.push).toEqual(['status'])
    expect(r.adopt).toEqual([])
    expect(r.conflicts).toEqual([])
  })

  it('adopts a field only JIRA changed', () => {
    const r = threeWay(snap(), base, snap({ due: '2026-05-01' }))
    expect(r.adopt).toEqual(['due'])
    expect(r.push).toEqual([])
  })

  it('merges disjoint changes without conflict (push mine, adopt theirs)', () => {
    const r = threeWay(snap({ due: '2026-09-09' }), base, snap({ title: 'Renamed' }))
    expect(r.push).toEqual(['due'])
    expect(r.adopt).toEqual(['title'])
    expect(r.conflicts).toEqual([])
  })

  it('flags a conflict when both change the same field differently', () => {
    const r = threeWay(snap({ start: '2026-02-02' }), base, snap({ start: '2026-03-03' }))
    expect(r.push).toEqual([])
    expect(r.adopt).toEqual([])
    expect(r.conflicts).toEqual([{ field: 'start', mine: '2026-02-02', theirs: '2026-03-03' }])
  })

  it('does not conflict when both changed a field to the SAME value', () => {
    const r = threeWay(snap({ status: 'done' }), base, snap({ status: 'done' }))
    expect(r).toEqual({ push: [], adopt: [], conflicts: [] })
  })

  it('treats assignees as an unordered set', () => {
    const r = threeWay(snap({ assignees: ['Alice', 'Bob'] }), base, snap({ assignees: ['Bob', 'Alice'] }))
    expect(r.conflicts).toEqual([]) // same set, different order → no change
  })

  it('treats blockedBy (dependencies) as an unordered set, push and adopt', () => {
    // local added a blocker → push; the rest unchanged
    const pushOnly = threeWay(snap({ blockedBy: ['PRJ-2'] }), base, snap())
    expect(pushOnly.push).toEqual(['blockedBy'])
    // JIRA added a blocker → adopt
    const adoptOnly = threeWay(snap(), base, snap({ blockedBy: ['PRJ-2'] }))
    expect(adoptOnly.adopt).toEqual(['blockedBy'])
    // both ended at the same set (different order) → no change
    const same = threeWay(snap({ blockedBy: ['PRJ-2', 'PRJ-3'] }), base, snap({ blockedBy: ['PRJ-3', 'PRJ-2'] }))
    expect(same.conflicts).toEqual([])
    expect(same.push).toEqual([])
  })

  it('handles multiple fields at once', () => {
    const r = threeWay(
      snap({ status: 'done', start: '2026-02-02', title: 'Mine' }),
      base,
      snap({ start: '2026-03-03', priority: 'high' })
    )
    expect(r.push.sort()).toEqual(['status', 'title'])
    expect(r.adopt).toEqual(['priority'])
    expect(r.conflicts).toEqual([{ field: 'start', mine: '2026-02-02', theirs: '2026-03-03' }])
  })
})

describe('conflictFields (resolver field list + default pick)', () => {
  it('lists only differing fields', () => {
    const diffs = conflictFields(snap({ status: 'done', due: '2026-05-05' }), base, snap({ status: 'in-progress' }))
    expect(diffs.map((d) => d.field).sort()).toEqual(['due', 'status'])
  })

  it('defaults to taking JIRA for fields we did not change locally (mine == base)', () => {
    // status: only JIRA moved (mine == base) → default take theirs.
    // start: only we moved (mine != base, theirs == base) → default keep ours.
    const diffs = conflictFields(snap({ start: '2026-02-02' }), base, snap({ status: 'done', start: '2026-01-01' }))
    const byField = Object.fromEntries(diffs.map((d) => [d.field, d.defaultTakeTheirs]))
    expect(byField.status).toBe(true)
    expect(byField.start).toBe(false)
  })

  it('keeps ours by default when there is no base (legacy task)', () => {
    const diffs = conflictFields(snap({ status: 'done' }), undefined, snap({ status: 'in-progress' }))
    expect(diffs).toEqual([{ field: 'status', defaultTakeTheirs: false }])
  })
})
