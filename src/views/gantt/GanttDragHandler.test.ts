import { describe, expect, it } from 'vitest'
import { resizePatch } from './GanttDragHandler'

// Resizing a bar writes the dragged end — plus the opposite end when the task only had
// one date, since the bar is rendered from whichever date exists.
const dates = { oldStart: '2026-08-10', oldDue: '2026-08-20', newStart: '2026-08-12', newDue: '2026-08-22' }

describe('resizePatch', () => {
  it('writes only the dragged end when the task already has both dates', () => {
    expect(resizePatch('left', dates)).toEqual({ start: '2026-08-12' })
    expect(resizePatch('right', dates)).toEqual({ due: '2026-08-22' })
  })

  it('fills the missing due date when resizing a start-only task', () => {
    expect(resizePatch('left', { ...dates, oldDue: '' })).toEqual({ start: '2026-08-12', due: '2026-08-22' })
  })

  it('fills the missing start date when resizing a due-only task', () => {
    // The reported bug: dragging the right edge of a due-only task left `start` empty,
    // so the stretched bar collapsed back to one day on the next render.
    expect(resizePatch('right', { ...dates, oldStart: '' })).toEqual({ start: '2026-08-12', due: '2026-08-22' })
  })
})
