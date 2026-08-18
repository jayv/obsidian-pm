import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, makeProject, makeTask } from '../../types'
import { buildGanttSvg } from './GanttSvgExport'

function projectWith(statuses: string[]) {
  const p = makeProject('Demo', 'Projects/Demo.md')
  p.tasks = statuses.map((status, i) =>
    makeTask({ id: `t${i}`, title: `Task ${i}`, status, start: '2026-07-01', due: '2026-07-05' })
  )
  return p
}

describe('buildGanttSvg — interactive status filter', () => {
  it('tags each row with its status', () => {
    const svg = buildGanttSvg(projectWith(['todo', 'done']), DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now')
    expect(svg).toContain('data-status="todo"')
    expect(svg).toContain('data-status="done"')
  })

  it('renders a status filter chip only for statuses actually used', () => {
    const svg = buildGanttSvg(projectWith(['todo', 'in-progress']), DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now')
    expect(svg).toContain('class="stf" data-status="todo"')
    expect(svg).toContain('class="stf" data-status="in-progress"')
    // Unused statuses get no chip.
    expect(svg).not.toContain('data-status="done"')
    // The chips are wired to the filter (selStatus drives filt()).
    expect(svg).toContain('selStatus')
  })
})

describe('buildGanttSvg — label column', () => {
  const badges = { badgesOf: () => [{ label: 'ACME-12', href: 'https://acme.example/browse/ACME-12' }] }

  function labelWidth(svg: string): number {
    const m = /"LABEL_W":(\d+(?:\.\d+)?)/.exec(svg)
    if (!m) throw new Error('LABEL_W missing from the embedded config')
    return parseFloat(m[1])
  }

  it('renders assignee avatars beside the task name', () => {
    const p = makeProject('Demo', 'Projects/Demo.md')
    // A milestone draws no bar, so any avatar in the output has to come from the label column.
    p.tasks = [
      makeTask({ id: 'm0', title: 'Launch', type: 'milestone', due: '2026-07-05', assignees: ['Ada Lovelace'] })
    ]
    const svg = buildGanttSvg(p, DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now')
    expect(svg).toContain('class="av"')
    expect(svg).toContain('>AL<')
  })

  it('renders badges as chips, linked when the badge has an href', () => {
    const svg = buildGanttSvg(projectWith(['todo']), DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now', badges)
    expect(svg).toContain('class="bdgt"')
    expect(svg).toContain('>ACME-12<')
    expect(svg).toContain('<a href="https://acme.example/browse/ACME-12" target="_blank" rel="noopener">')
  })

  it('omits badge chips entirely when no provider is given', () => {
    const svg = buildGanttSvg(projectWith(['todo']), DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now')
    expect(svg).not.toContain('class="bdg"')
  })

  it('widens the label column to fit badges and avatars instead of overlapping the title', () => {
    const plain = projectWith(['todo'])
    const bare = labelWidth(buildGanttSvg(plain, DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now'))

    const withBadge = labelWidth(buildGanttSvg(plain, DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now', badges))
    expect(withBadge).toBeGreaterThan(bare)

    const assigned = projectWith(['todo'])
    assigned.tasks[0].assignees = ['Ada Lovelace', 'Grace Hopper']
    const withBoth = labelWidth(buildGanttSvg(assigned, DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now', badges))
    expect(withBoth).toBeGreaterThan(withBadge)
  })

  it('grows the column rather than eating into the task name', () => {
    const long = projectWith(['todo'])
    long.tasks[0].title = 'A really quite long task name that will not fit in the column'
    const bare = buildGanttSvg(long, DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now')
    const crowded = buildGanttSvg(long, DEFAULT_STATUSES, DEFAULT_PRIORITIES, 'week', 'now', badges)
    const nameOf = (svg: string) => /class="rlabel"[^>]*>([^<]*)</.exec(svg)?.[1] ?? ''
    expect(nameOf(bare)).toContain('…')
    // Badges are added beside the name column, so the name itself is unaffected.
    expect(nameOf(crowded)).toBe(nameOf(bare))
  })
})
