import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STATUSES, makeDefaultFilter, makeTask, type FilterState, type Task } from '../types'
import {
  applyTaskFilter,
  applyTaskFilterFlat,
  applyTaskFilterPromote,
  cloneFilter,
  countActiveFilters,
  filterEquals,
  isFilterActive,
  matchesFilter
} from './TaskFilter'
import { flattenTasks } from './TaskTreeOps'

function task(overrides: Partial<Task> & { id: string }): Task {
  return makeTask(overrides)
}

function filter(overrides: Partial<FilterState> = {}): FilterState {
  return { ...makeDefaultFilter(), ...overrides }
}

describe('isFilterActive', () => {
  it('returns false for the default filter', () => {
    expect(isFilterActive(makeDefaultFilter())).toBe(false)
  })

  it('returns true when text is set', () => {
    expect(isFilterActive(filter({ text: 'foo' }))).toBe(true)
  })

  it('returns true when any list filter has entries', () => {
    expect(isFilterActive(filter({ statuses: ['todo'] }))).toBe(true)
    expect(isFilterActive(filter({ priorities: ['high'] }))).toBe(true)
    expect(isFilterActive(filter({ assignees: ['alice'] }))).toBe(true)
    expect(isFilterActive(filter({ tags: ['urgent'] }))).toBe(true)
  })

  it('returns true when dueDateFilter is not "any"', () => {
    expect(isFilterActive(filter({ dueDateFilter: 'overdue' }))).toBe(true)
  })

  it('returns true when activeThisWeek is on', () => {
    expect(isFilterActive(filter({ activeThisWeek: true }))).toBe(true)
  })

  it('ignores showArchived (matches legacy semantics)', () => {
    expect(isFilterActive(filter({ showArchived: true }))).toBe(false)
  })
})

describe('countActiveFilters', () => {
  it('counts each active filter once', () => {
    expect(countActiveFilters(makeDefaultFilter())).toBe(0)
    expect(
      countActiveFilters(
        filter({
          text: 'x',
          statuses: ['todo'],
          priorities: ['high'],
          assignees: ['a'],
          tags: ['t'],
          dueDateFilter: 'overdue',
          showArchived: true
        })
      )
    ).toBe(7)
  })

  it('counts showArchived', () => {
    expect(countActiveFilters(filter({ showArchived: true }))).toBe(1)
  })
})

describe('cloneFilter', () => {
  it('copies scalars and clones arrays (no shared references)', () => {
    const src = filter({ statuses: ['todo'], assignees: ['Zoe'], text: 'x', activeThisWeek: true })
    const copy = cloneFilter(src)
    expect(copy).toEqual(src)
    expect(copy.statuses).not.toBe(src.statuses)
    expect(copy.assignees).not.toBe(src.assignees)
    // Mutating the clone's arrays (as the avatar filter does with splice/push) must not
    // leak back into the source — this is what corrupted saved views before.
    copy.assignees.push('Bob')
    expect(src.assignees).toEqual(['Zoe'])
  })
})

describe('filterEquals', () => {
  it('is true for equal filters regardless of list order', () => {
    const a = filter({ statuses: ['todo', 'done'], priorities: ['high'] })
    const b = filter({ statuses: ['done', 'todo'], priorities: ['high'] })
    expect(filterEquals(a, b)).toBe(true)
  })

  it('detects differences in any field', () => {
    const base = filter({ statuses: ['todo'], text: 'x', activeThisWeek: true })
    expect(filterEquals(base, filter({ statuses: ['todo'], text: 'y', activeThisWeek: true }))).toBe(false)
    expect(filterEquals(base, filter({ statuses: ['todo', 'done'], text: 'x', activeThisWeek: true }))).toBe(false)
    expect(filterEquals(base, filter({ statuses: ['todo'], text: 'x', activeThisWeek: false }))).toBe(false)
    expect(filterEquals(makeDefaultFilter(), makeDefaultFilter())).toBe(true)
  })
})

describe('matchesFilter', () => {
  it('hides archived tasks when showArchived is false', () => {
    const t = task({ id: 'a', archived: true })
    expect(matchesFilter(t, filter())).toBe(false)
    expect(matchesFilter(t, filter({ showArchived: true }))).toBe(true)
  })

  it('matches text against title, status, priority, assignees, and tags', () => {
    const t = task({ id: 'a', title: 'Refactor parser', assignees: ['Bob'], tags: ['cleanup'] })
    expect(matchesFilter(t, filter({ text: 'parser' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: 'BOB' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: 'cleanup' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: 'unrelated' }))).toBe(false)
  })

  it('matches text against a connector ext string (e.g. the Jira key)', () => {
    const t = task({ id: 'a', title: 'Build', ext: { jira: { key: 'ENG-1234', sync: true } } })
    expect(matchesFilter(t, filter({ text: 'eng-1234' }))).toBe(true) // case-insensitive
    expect(matchesFilter(t, filter({ text: 'eng-1' }))).toBe(true) // substring
    expect(matchesFilter(t, filter({ text: 'eng-9999' }))).toBe(false)
  })

  it('filters by status, priority, assignees, tags', () => {
    const t = task({ id: 'a', status: 'in-progress', priority: 'high', assignees: ['Alice'], tags: ['x'] })
    expect(matchesFilter(t, filter({ statuses: ['in-progress'] }))).toBe(true)
    expect(matchesFilter(t, filter({ statuses: ['done'] }))).toBe(false)
    expect(matchesFilter(t, filter({ priorities: ['high'] }))).toBe(true)
    expect(matchesFilter(t, filter({ priorities: ['low'] }))).toBe(false)
    expect(matchesFilter(t, filter({ assignees: ['Alice'] }))).toBe(true)
    expect(matchesFilter(t, filter({ assignees: ['Bob'] }))).toBe(false)
    expect(matchesFilter(t, filter({ tags: ['x'] }))).toBe(true)
    expect(matchesFilter(t, filter({ tags: ['y'] }))).toBe(false)
  })

  it('treats no-date dueDateFilter correctly', () => {
    expect(matchesFilter(task({ id: 'a', due: '' }), filter({ dueDateFilter: 'no-date' }))).toBe(true)
    expect(matchesFilter(task({ id: 'b', due: '2026-01-01' }), filter({ dueDateFilter: 'no-date' }))).toBe(false)
  })

  describe('this-week covers the whole week, not just today onward', () => {
    afterEach(() => vi.useRealTimers())

    it('matches any day of the current week (Mon–Sun), including days already past', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-01T12:00:00Z')) // a Wednesday; week = Mon 06-29 … Sun 07-05
      const f = filter({ dueDateFilter: 'this-week' })
      const m = (due: string) => matchesFilter(task({ id: due, due, status: 'done' }), f, DEFAULT_STATUSES)

      expect(m('2026-06-29')).toBe(true) // Monday (earlier this week, e.g. completed)
      expect(m('2026-07-01')).toBe(true) // today
      expect(m('2026-07-05')).toBe(true) // Sunday (end of week)
      expect(m('2026-06-28')).toBe(false) // last week's Sunday
      expect(m('2026-07-06')).toBe(false) // next Monday
    })
  })

  describe('activeThisWeek matches tasks whose span overlaps the current week', () => {
    afterEach(() => vi.useRealTimers())

    it('overlaps by span, not just the due date', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-01T12:00:00Z')) // Wednesday; week = Mon 06-29 … Sun 07-05
      const f = filter({ activeThisWeek: true })
      const m = (start: string, due: string) => matchesFilter(task({ id: `${start}/${due}`, start, due }), f)

      expect(m('2026-06-20', '2026-07-10')).toBe(true) // spans across the whole week
      expect(m('2026-07-03', '2026-07-03')).toBe(true) // single day inside the week
      expect(m('2026-06-25', '2026-06-30')).toBe(true) // starts before, ends inside
      expect(m('2026-07-04', '2026-07-20')).toBe(true) // starts inside, ends after
      expect(m('2026-06-01', '2026-06-28')).toBe(false) // ends before the week starts
      expect(m('2026-07-06', '2026-07-09')).toBe(false) // starts after the week ends
    })

    it('uses whichever single date exists, and excludes dateless tasks', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-01T12:00:00Z'))
      const f = filter({ activeThisWeek: true })
      expect(matchesFilter(task({ id: 'due-only', due: '2026-07-02' }), f)).toBe(true)
      expect(matchesFilter(task({ id: 'start-only', start: '2026-07-02' }), f)).toBe(true)
      expect(matchesFilter(task({ id: 'no-dates', start: '', due: '' }), f)).toBe(false)
    })
  })
})

describe('applyTaskFilter (tree-shaped)', () => {
  it('keeps tasks that match and rebuilds subtask trees', () => {
    const tasks = [
      task({ id: 'a', status: 'todo', subtasks: [task({ id: 'a1', status: 'todo' })] }),
      task({ id: 'b', status: 'done' })
    ]
    const out = applyTaskFilter(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['a'])
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['a1'])
  })

  it('drops the entire subtree when the parent is filtered out (strict tree)', () => {
    const tasks = [task({ id: 'a', status: 'done', subtasks: [task({ id: 'a1', status: 'todo' })] })]
    const out = applyTaskFilter(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out).toEqual([])
  })

  it('does not mutate the input tree', () => {
    const child = task({ id: 'a1', status: 'done' })
    const parent = task({ id: 'a', status: 'todo', subtasks: [child] })
    const out = applyTaskFilter([parent], filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(parent.subtasks).toEqual([child])
    expect(out[0].subtasks).toEqual([])
  })
})

describe('applyTaskFilterPromote', () => {
  it('lifts a matching grandchild to the slot of its dropped parent', () => {
    const tasks = [
      task({
        id: 'root',
        status: 'todo',
        subtasks: [task({ id: 'mid', status: 'done', subtasks: [task({ id: 'leaf', status: 'todo' })] })]
      })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['root'])
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['leaf'])
  })

  it('promotes orphans all the way to top level when ancestors are dropped', () => {
    const tasks = [
      task({
        id: 'root',
        status: 'done',
        subtasks: [task({ id: 'mid', status: 'done', subtasks: [task({ id: 'leaf', status: 'todo' })] })]
      })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['leaf'])
  })

  it('preserves a promoted task’s own subtree', () => {
    const tasks = [
      task({
        id: 'root',
        status: 'done',
        subtasks: [
          task({
            id: 'mid',
            status: 'todo',
            subtasks: [task({ id: 'leaf', status: 'todo' })]
          })
        ]
      })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['mid'])
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['leaf'])
  })

  it('drops branches with no matching descendants', () => {
    const tasks = [
      task({ id: 'a', status: 'done', subtasks: [task({ id: 'a1', status: 'done' })] }),
      task({ id: 'b', status: 'todo' })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['b'])
  })

  it('hides a matching parent when all its subtasks are filtered out (no childless summary)', () => {
    // Parent matches, but its only subtask doesn't → the parent would otherwise render
    // as a lone normal bar in the gantt, so it's dropped too.
    const tasks = [task({ id: 'p', status: 'todo', subtasks: [task({ id: 'c', status: 'done' })] })]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out).toEqual([])
  })

  it('keeps a matching parent when at least one subtask survives', () => {
    const tasks = [
      task({
        id: 'p',
        status: 'todo',
        subtasks: [task({ id: 'c1', status: 'todo' }), task({ id: 'c2', status: 'done' })]
      })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['p'])
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['c1'])
  })

  it('keeps a matching leaf (no subtasks) — the drop only applies to real parents', () => {
    const out = applyTaskFilterPromote(
      [task({ id: 'leaf', status: 'todo' })],
      filter({ statuses: ['todo'] }),
      DEFAULT_STATUSES
    )
    expect(out.map((t) => t.id)).toEqual(['leaf'])
  })
})

describe('applyTaskFilterFlat', () => {
  it('returns only entries whose task matches', () => {
    const tasks = [task({ id: 'a', status: 'todo' }), task({ id: 'b', status: 'done' })]
    const flat = flattenTasks(tasks)
    const out = applyTaskFilterFlat(flat, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((f) => f.task.id)).toEqual(['a'])
  })

  it('respects showArchived', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', archived: true })]
    const flat = flattenTasks(tasks)
    expect(applyTaskFilterFlat(flat, filter(), DEFAULT_STATUSES).map((f) => f.task.id)).toEqual(['a'])
    expect(applyTaskFilterFlat(flat, filter({ showArchived: true }), DEFAULT_STATUSES).map((f) => f.task.id)).toEqual([
      'a',
      'b'
    ])
  })
})
