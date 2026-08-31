import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeTask } from '../types'
import type { Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { outlineMarkdown } from './taskOutline'

const noBadges = (): { label: string; href?: string }[] => []
const opts = (over: Partial<Parameters<typeof outlineMarkdown>[1]> = {}) => ({
  statuses: DEFAULT_STATUSES,
  badgesOf: noBadges,
  ...over
})

describe('markdown outline', () => {
  const child = makeTask({ id: 'c', title: 'Child', status: 'todo', due: '2026-09-04' })
  const parent = makeTask({ id: 'p', title: 'Parent', status: 'in-progress', subtasks: [child] })

  it('indents by the row depth, so the outline is the tree', () => {
    const md = outlineMarkdown(flattenTasks([parent]), opts())
    const lines = md.split('\n')
    expect(lines[0].startsWith('- ')).toBe(true)
    expect(lines[1].startsWith('    - ')).toBe(true)
    expect(lines[1]).toContain('Child')
  })

  it('renders the rows it is given, in that order — it does not re-filter', () => {
    // The point of taking rows: whatever the chart decided is visible (filtered,
    // promoted, collapsed) is what gets copied. Re-deriving it here would be a second
    // implementation free to disagree with the chart it claims to mirror.
    const rows = flattenTasks([parent]).filter((f) => f.task.id === 'c')
    expect(outlineMarkdown(rows, opts())).toContain('Child')
    expect(outlineMarkdown(rows, opts())).not.toContain('Parent')
  })

  it('carries the status icon, due date and assignees', () => {
    const t = makeTask({ title: 'Ship it', status: 'todo', due: '2026-09-04', assignees: ['Jo', 'Sam'] })
    const line = outlineMarkdown(flattenTasks([t]), opts())
    expect(line).toContain('Ship it')
    expect(line).toContain('_(2026-09-04)_')
    expect(line).toContain('— Jo, Sam')
  })

  it('omits the empty fields rather than leaving dangling punctuation', () => {
    const t = makeTask({ title: 'Bare', status: 'todo' })
    expect(outlineMarkdown(flattenTasks([t]), opts())).not.toMatch(/_\(|—/)
  })

  it('links a badge when the connector gives a URL, and shows it plain when it does not', () => {
    const t = makeTask({ title: 'Linked', status: 'todo' })
    const linked = outlineMarkdown(
      flattenTasks([t]),
      opts({ badgesOf: () => [{ label: 'ENG-1', href: 'https://x/browse/ENG-1' }] })
    )
    expect(linked).toContain('[ENG-1](https://x/browse/ENG-1)')
    const plain = outlineMarkdown(flattenTasks([t]), opts({ badgesOf: () => [{ label: 'ENG-1' }] }))
    expect(plain).toContain('[ENG-1]')
    expect(plain).not.toContain('](')
  })

  it('renders a project heading as a bold title, without task fields', () => {
    // A heading row stands for a project: no status, no dates, nobody assigned. Rendering
    // those anyway would put a row of blanks above every group.
    const heading = makeTask({ id: 'h', title: 'Athlon', status: 'todo', due: '2026-09-04' })
    const md = outlineMarkdown(
      flattenTasks([heading]),
      opts({
        isHeading: (t: Task) => t.id === 'h',
        badgesOf: () => [{ label: 'ENG-13665' }]
      })
    )
    expect(md).toBe('- **Athlon** [ENG-13665]')
  })

  it('nests a project heading over its tasks, the way the chart draws it', () => {
    const project = makeTask({ id: 'h', title: 'Athlon', subtasks: [parent] })
    const lines = outlineMarkdown(flattenTasks([project]), opts({ isHeading: (t: Task) => t.id === 'h' })).split('\n')
    const indentOf = (line: string): number => line.length - line.trimStart().length
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('- **Athlon**')
    expect([indentOf(lines[0]), indentOf(lines[1]), indentOf(lines[2])]).toEqual([0, 4, 8])
    expect(lines[1]).toContain('Parent')
    expect(lines[2]).toContain('Child')
    expect(lines[2]).toContain('_(2026-09-04)_')
  })

  it('applies the display-name form to assignees', () => {
    const t = makeTask({ title: 'T', status: 'todo', assignees: ['Jo Voordeckers'] })
    const md = outlineMarkdown(flattenTasks([t]), opts({ displayName: (n: string) => n.split(' ')[0] }))
    expect(md).toContain('— Jo')
    expect(md).not.toContain('Voordeckers')
  })
})
