/**
 * Pure geometry for the Gantt's bars — no DOM, no Obsidian.
 *
 * Kept out of the renderer so it can be tested directly: importing the renderer drags in
 * the modal chain (and through it half of Obsidian's API surface), which a shape has no
 * business needing.
 */
/**
 * The summary bracket's geometry: a thick line with legs dropping at each end.
 *
 * A project row is drawn heavier and doubled — thicker, longer legs, plus a second thin
 * line beneath. Two strokes read as a different KIND of row at a glance, where a merely
 * thicker single bar reads as the same row drawn bigger.
 */
export function summaryBracket(
  x: number,
  y: number,
  width: number,
  isProject: boolean
): { points: string; underline?: { x: number; y: number; width: number; height: number } } {
  // The project bracket's two lines are closer in weight than they were: the thick one
  // dropped and the thin one rose, because at 6px against 2px the second line read as an
  // artefact of the first rather than a line of its own.
  const thickness = isProject ? 5 : 4
  const leg = isProject ? 12 : 9
  const legW = Math.min(isProject ? 8 : 6, width / 2)
  const points = [
    `${x},${y}`,
    `${x + width},${y}`,
    `${x + width},${y + leg}`,
    `${x + width - legW},${y + thickness}`,
    `${x + legW},${y + thickness}`,
    `${x},${y + leg}`
  ].join(' ')
  if (!isProject) return { points }
  return { points, underline: { x, y: y + thickness + 3, width, height: 3 } }
}
