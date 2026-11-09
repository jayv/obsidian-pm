import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeTask } from '../types'
import type { Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { assigneeOutline, collapseParents, outlineMarkdown, projectOutline, titlePaths } from './taskOutline'

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
    const t = makeTask({ title: 'Ship it', status: 'todo', due: '2026-09-04', assignees: ['Ann', 'Sam'] })
    const line = outlineMarkdown(flattenTasks([t]), opts())
    expect(line).toContain('Ship it')
    expect(line).toContain('_(2026-09-04)_')
    expect(line).toContain('— Ann, Sam')
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
    const t = makeTask({ title: 'T', status: 'todo', assignees: ['Ann Example'] })
    const md = outlineMarkdown(flattenTasks([t]), opts({ displayName: (n: string) => n.split(' ')[0] }))
    expect(md).toContain('— Ann')
    expect(md).not.toContain('Example')
  })
})

describe('collapsing redundant parents', () => {
  const heading = (id: string, title: string, subtasks: Task[]): Task => makeTask({ id, title, subtasks })
  const isHeading = (t: Task): boolean => t.id.startsWith('h')

  it('drops a parent whose sub-tasks are also on the list', () => {
    const child = makeTask({ id: 'c', title: 'Child' })
    const parent = makeTask({ id: 'p', title: 'Parent', subtasks: [child] })
    const { rows } = collapseParents(flattenTasks([parent]))
    expect(rows.map((r) => r.task.title)).toEqual(['Child'])
  })

  it('keeps a task that has no sub-tasks — it was never a parent', () => {
    const leaf = makeTask({ id: 'l', title: 'Leaf' })
    expect(collapseParents(flattenTasks([leaf])).rows.map((r) => r.task.title)).toEqual(['Leaf'])
  })

  it('keeps a parent whose sub-tasks are NOT on the list', () => {
    // A branch the chart has collapsed contributes only its parent row. Dropping that
    // would export nothing for it at all — less than the chart shows, and silently.
    const child = makeTask({ id: 'c', title: 'Child' })
    const parent = makeTask({ id: 'p', title: 'Parent', subtasks: [child] })
    const collapsedInChart = flattenTasks([parent]).filter((r) => r.task.id === 'p')
    expect(collapseParents(collapsedInChart).rows.map((r) => r.task.title)).toEqual(['Parent'])
  })

  it('re-seats survivors so nothing is indented under a parent that is gone', () => {
    const grandchild = makeTask({ id: 'g', title: 'Grandchild' })
    const child = makeTask({ id: 'c', title: 'Child', subtasks: [grandchild] })
    const parent = makeTask({ id: 'p', title: 'Parent', subtasks: [child] })
    const { rows } = collapseParents(flattenTasks([heading('h1', 'Project', [parent])]), isHeading)
    // Only the project row and the leaf survive; the leaf sits directly under it.
    expect(rows.map((r) => [r.task.title, r.depth])).toEqual([
      ['Project', 0],
      ['Grandchild', 1]
    ])
  })

  it('keeps the project row it is grouping under', () => {
    const leaf = makeTask({ id: 'l', title: 'Leaf' })
    const { rows } = collapseParents(flattenTasks([heading('h1', 'Project', [leaf])]), isHeading)
    expect(rows.map((r) => r.task.title)).toEqual(['Project', 'Leaf'])
  })

  it('drops a project row with nothing left under it', () => {
    const { rows } = collapseParents(flattenTasks([heading('h1', 'Empty', [])]), isHeading)
    expect(rows).toEqual([])
  })

  it('produces an outline of project rows and leaves only', () => {
    const a = makeTask({ id: 'a', title: 'Leaf A', status: 'todo' })
    const b = makeTask({ id: 'b', title: 'Leaf B', status: 'todo' })
    const container = makeTask({ id: 'p', title: 'Container', status: 'todo', subtasks: [a, b] })
    const { rows } = collapseParents(flattenTasks([heading('h1', 'Athlon', [container])]), isHeading)
    const lines = outlineMarkdown(rows, opts({ isHeading })).split('\n')
    expect(lines[0]).toBe('- **Athlon**')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('Leaf A')
    expect(lines[1].startsWith('    - ')).toBe(true)
    expect(lines.join(' ')).not.toContain('Container')
  })
})

describe('ancestor paths', () => {
  const isHeading = (t: Task): boolean => t.id.startsWith('h')
  const grandchild = makeTask({ id: 'g', title: 'Grandchild', status: 'todo' })
  const child = makeTask({ id: 'c', title: 'Child', status: 'todo', subtasks: [grandchild] })
  const parent = makeTask({ id: 'p', title: 'Parent', status: 'todo', subtasks: [child] })
  const project = makeTask({ id: 'h1', title: 'Athlon', subtasks: [parent] })

  it('prefixes the ancestor chain, like the per-project export', () => {
    const paths = titlePaths(flattenTasks([project]), isHeading)
    expect(paths.get('g')).toBe('Parent > Child > Grandchild')
    expect(paths.get('c')).toBe('Parent > Child')
    expect(paths.get('p')).toBe('Parent')
  })

  it('stops at the project row — that row already names the project', () => {
    const paths = titlePaths(flattenTasks([project]), isHeading)
    expect(paths.get('g')).not.toContain('Athlon')
    expect(paths.get('h1')).toBe('Athlon')
  })

  it('returns the paths with the rows, so they cannot be taken from the collapsed set', () => {
    // Computing them afterwards is the one way to get bare titles back, so the API hands
    // both over together and never exposes the collapsed rows on their own.
    const { rows, paths } = collapseParents(flattenTasks([project]), isHeading)
    expect(rows.map((r) => r.task.id)).toEqual(['h1', 'g']) // 'p' and 'c' collapsed away
    expect(paths.get('g')).toBe('Parent > Child > Grandchild') // yet their names survive
  })

  it('keeps the names of the parents the collapse removes', () => {
    // The whole point: the chain is taken before collapseParents runs, so a leaf that
    // survives on its own still says what it belongs to.
    const { rows, paths } = collapseParents(flattenTasks([project]), isHeading)
    const md = outlineMarkdown(rows, opts({ isHeading, titleOf: (t: Task) => paths.get(t.id) ?? t.title }))
    expect(md.split('\n')).toHaveLength(2)
    expect(md).toContain('- **Athlon**')
    expect(md).toContain('Parent > Child > Grandchild')
  })

  it('leaves a top-level task as just its own title', () => {
    const flat = makeTask({ id: 't', title: 'Standalone', status: 'todo' })
    const paths = titlePaths(flattenTasks([makeTask({ id: 'h1', title: 'P', subtasks: [flat] })]), isHeading)
    expect(paths.get('t')).toBe('Standalone')
  })
})

describe('assignee grouping', () => {
  const t = (title: string, over: Partial<Task> = {}): Task => makeTask({ title, status: 'todo', ...over })

  it('groups under an @-mention header, with the work indented beneath', () => {
    // The mention is the point: a pasted update pings the people in it.
    const lines = assigneeOutline([t('A', { assignees: ['Ann'] })], opts())
    expect(lines[0]).toBe('- @Ann')
    expect(lines[1].startsWith('    - ')).toBe(true)
    expect(lines[1]).toContain('A')
  })

  it('drops the inline assignee suffix under a header that already names them', () => {
    const lines = assigneeOutline([t('A', { assignees: ['Ann'] })], opts())
    expect(lines[1]).not.toContain('—')
  })

  it('sorts named people alphabetically and puts Unassigned last', () => {
    const lines = assigneeOutline([t('c'), t('b', { assignees: ['Sam'] }), t('a', { assignees: ['Ann'] })], opts())
    expect(lines.filter((l) => l.startsWith('- '))).toEqual(['- @Ann', '- @Sam', '- *Unassigned*'])
  })

  it('gives milestones their own group, first — they are markers, not anyone’s work', () => {
    const lines = assigneeOutline([t('Work', { assignees: ['Ann'] }), t('Cut', { type: 'milestone' })], opts())
    expect(lines[0]).toBe('- *Milestones*')
    expect(lines[1]).toContain('Cut')
    expect(lines[2]).toBe('- @Ann')
  })

  it('orders each group by due date, undated last', () => {
    const items = [
      t('later', { assignees: ['Ann'], due: '2026-09-09' }),
      t('undated', { assignees: ['Ann'] }),
      t('sooner', { assignees: ['Ann'], due: '2026-09-01' })
    ]
    const lines = assigneeOutline(items, opts())
    const titles = lines
      .slice(1)
      .map((l) => (l.includes('sooner') ? 'sooner' : l.includes('later') ? 'later' : 'undated'))
    expect(titles).toEqual(['sooner', 'later', 'undated'])
  })

  it('nests under a base depth, for the all-projects export', () => {
    const lines = assigneeOutline([t('A', { assignees: ['Ann'] })], opts(), 1)
    expect(lines[0]).toBe('    - @Ann')
    expect(lines[1].startsWith('        - ')).toBe(true)
  })

  it('mentions every assignee on a shared task', () => {
    expect(assigneeOutline([t('A', { assignees: ['Ann', 'Sam'] })], opts())[0]).toBe('- @Ann, @Sam')
  })
})

describe('project outline', () => {
  it('lists carried-over rows in their own group after the assignee groups, with the assignee on the line', () => {
    const now = makeTask({ id: 'n', title: 'Now', status: 'todo', due: '2026-09-04', assignees: ['Ann'] })
    const late = makeTask({ id: 'l', title: 'Late', status: 'todo', due: '2026-08-28', assignees: ['Bob'] })
    const h = makeTask({ id: 'h', title: 'Proj', subtasks: [now, late] })
    const lines = projectOutline(flattenTasks([h]), {
      ...opts(),
      isHeading: (x: Task) => x.id === 'h',
      carried: new Set(['l'])
    })
    expect(lines).toEqual([
      '- **Proj**',
      '    - @Ann',
      '        - 📋 Now _(2026-09-04)_',
      '    - *Carried over*',
      '        - 📋 Late _(2026-08-28)_ — Bob'
    ])
  })
})
