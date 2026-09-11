/**
 * Pure geometry for the Gantt's bars — no DOM, no Obsidian.
 *
 * Kept out of the renderer so it can be tested directly: importing the renderer drags in
 * the modal chain (and through it half of Obsidian's API surface), which a shape has no
 * business needing.
 */
/**
 * The summary bracket's geometry: a band with legs dropping at each end.
 *
 * A project row is drawn deeper than a parent task's and filled with a top-to-bottom fade
 * rather than a flat colour (see the renderer). The depth is what the fade needs to read
 * at all — at a task bracket's 4px there is nowhere for it to go — and the fade is what
 * distinguishes the row, so the two go together.
 *
 * An earlier attempt drew a second thin line under the first instead. Brought close enough
 * in weight to be legible, the pair just read as a box.
 */
export function summaryBracket(x: number, y: number, width: number, isProject: boolean): { points: string } {
  const thickness = isProject ? 10 : 4
  const leg = isProject ? 14 : 9
  const legW = Math.min(isProject ? 8 : 6, width / 2)
  const points = [
    `${x},${y}`,
    `${x + width},${y}`,
    `${x + width},${y + leg}`,
    `${x + width - legW},${y + thickness}`,
    `${x + legW},${y + thickness}`,
    `${x},${y + leg}`
  ].join(' ')
  return { points }
}

/**
 * A stable element id for one colour's fade, so the gradient is defined once per colour
 * and reused by every project row using it, rather than once per row.
 */
export function fadeGradientId(color: string): string {
  return `pm-summary-fade-${color.replace(/[^a-zA-Z0-9]/g, '')}`
}

/** Top-to-bottom fade stops: the project's colour, falling away to nearly nothing. */
export const FADE_STOPS = [
  { offset: '0%', opacity: 1 },
  { offset: '100%', opacity: 0.08 }
] as const
