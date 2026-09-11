import { describe, expect, it } from 'vitest'
import { summaryBracket } from './GanttBarGeometry'

/*
 * In the all-projects chart every project drew the same accent-blue summary bracket as an
 * ordinary parent task, so several projects read as one flat pile of nested summaries with
 * no way to see where a project began. A project row is now heavier and doubled — and the
 * two shapes have to stay distinguishable, not merely differently coloured, because the
 * colour alone is a project's own and can be anything.
 */
describe('summary bracket geometry', () => {
  const y = 100
  const yOf = (points: string, i: number): number => Number(points.split(' ')[i].split(',')[1])

  it('drops legs at both ends from a flat top edge', () => {
    const { points } = summaryBracket(10, y, 200, false)
    const parts = points.split(' ')
    expect(parts).toHaveLength(6)
    expect(yOf(points, 0)).toBe(y) // top-left
    expect(yOf(points, 1)).toBe(y) // top-right
    expect(yOf(points, 2)).toBeGreaterThan(yOf(points, 3)) // right leg drops below the bar
    expect(yOf(points, 5)).toBeGreaterThan(yOf(points, 4)) // left leg too
  })

  it('makes a project bracket thicker, with longer legs', () => {
    const task = summaryBracket(10, y, 200, false)
    const project = summaryBracket(10, y, 200, true)
    expect(yOf(project.points, 4) - y).toBeGreaterThan(yOf(task.points, 4) - y) // thickness
    expect(yOf(project.points, 5) - y).toBeGreaterThan(yOf(task.points, 5) - y) // leg drop
  })

  it('doubles a project bracket with a second line, and only a project one', () => {
    expect(summaryBracket(10, y, 200, false).underline).toBeUndefined()
    const { underline } = summaryBracket(10, y, 200, true)
    expect(underline).toEqual({ x: 10, y: y + 8, width: 200, height: 2 })
  })

  it('keeps the underline clear of the bar above it', () => {
    const { points, underline } = summaryBracket(0, y, 200, true)
    const barBottom = yOf(points, 4)
    expect(underline?.y).toBeGreaterThan(barBottom) // a visible gap, not a thicker bar
  })

  it('never lets the legs meet in the middle of a narrow bar', () => {
    // A one-day project would otherwise draw its two legs crossing over each other.
    const width = 6
    const { points } = summaryBracket(0, y, width, true)
    const leftLegX = Number(points.split(' ')[4].split(',')[0])
    const rightLegX = Number(points.split(' ')[3].split(',')[0])
    expect(leftLegX).toBeLessThanOrEqual(rightLegX)
  })
})
