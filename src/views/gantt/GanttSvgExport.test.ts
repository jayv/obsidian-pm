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
