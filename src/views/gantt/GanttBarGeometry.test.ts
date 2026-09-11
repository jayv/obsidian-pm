import { describe, expect, it } from 'vitest'
import { FADE_STOPS, fadeGradientId, summaryBracket } from './GanttBarGeometry'

/*
 * In the all-projects chart every project drew the same accent-blue summary bracket as an
 * ordinary parent task, so several projects read as one flat pile of nested summaries with
 * no way to see where a project began. A project row is now a deeper band filled with a
 * top-to-bottom fade — the shapes have to stay distinguishable, not merely differently
 * coloured, because the colour alone is a project's own and can be anything.
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

  it('gives the fade room to read — a task bracket is too thin for one', () => {
    // 4px has nowhere for a gradient to go, which is why the project band is deeper.
    const task = summaryBracket(0, y, 200, false)
    const project = summaryBracket(0, y, 200, true)
    const depth = (points: string): number => Number(points.split(' ')[4].split(',')[1]) - y
    expect(depth(task.points)).toBe(4)
    expect(depth(project.points)).toBeGreaterThanOrEqual(8)
  })

  it('fades from the colour to nearly nothing, top to bottom', () => {
    expect(FADE_STOPS[0]).toEqual({ offset: '0%', opacity: 1 })
    expect(FADE_STOPS[FADE_STOPS.length - 1].offset).toBe('100%')
    expect(FADE_STOPS[FADE_STOPS.length - 1].opacity).toBeLessThan(0.2)
  })

  it('keys the gradient by colour, so one is defined per colour and not per row', () => {
    expect(fadeGradientId('#0c69e4')).toBe(fadeGradientId('#0c69e4'))
    expect(fadeGradientId('#0c69e4')).not.toBe(fadeGradientId('#8b72be'))
  })

  it('makes an id that is safe to select with, whatever the colour looks like', () => {
    // Colours arrive as the user set them — '#abc', 'rgb(1, 2, 3)', a CSS variable.
    for (const color of ['#0c69e4', 'rgb(12, 105, 228)', 'var(--interactive-accent)']) {
      expect(fadeGradientId(color)).toMatch(/^pm-summary-fade-[a-zA-Z0-9]+$/)
    }
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
