import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeProject, makeTask } from '../types'
import type { FilterState, Project, SavedView } from '../types'
import { findSavedView, groupByProject, parseTasksBlock, selectBlockTasks, uberSavedViews } from './tasksBlock'

const filter = (over: Partial<FilterState> = {}): FilterState => ({
  text: '',
  statuses: [],
  priorities: [],
  assignees: [],
  tags: [],
  dueDateFilter: 'any',
  activeWeeks: [],
  showArchived: false,
  ...over
})

const project = (title: string, tasks: ReturnType<typeof makeTask>[]): Project => {
  const p = makeProject(title, `Projects/${title}.md`)
  p.tasks = tasks
  return p
}

describe('pm-tasks block — parsing', () => {
  it('reads the options it knows', () => {
    const spec = parseTasksBlock('view: My work\ngroup: none\nlimit: 5\ntitle: This week')
    expect(spec).toMatchObject({ view: 'My work', group: 'none', limit: 5, title: 'This week', errors: [] })
  })

  it('defaults to grouping by project with no cap', () => {
    const spec = parseTasksBlock('view: My work')
    expect(spec.group).toBe('project')
    expect(spec.limit).toBe(0)
  })

  it('ignores blank lines and comments', () => {
    expect(parseTasksBlock('\n# which view\nview: My work\n\n').errors).toEqual([])
  })

  it('names an unknown option instead of ignoring it', () => {
    // Silently dropping it would leave the user staring at a panel that ignores what
    // they asked for, with nothing to explain why.
    const spec = parseTasksBlock('view: My work\nassignee: Jo')
    expect(spec.errors.join(' ')).toContain('assignee')
    expect(spec.view).toBe('My work') // the rest of the block still applies
  })

  it('rejects a non-numeric limit and a bad group', () => {
    const spec = parseTasksBlock('view: V\nlimit: soon\ngroup: sideways')
    expect(spec.errors).toHaveLength(2)
    expect(spec.limit).toBe(0)
    expect(spec.group).toBe('project')
  })

  it('requires a view', () => {
    expect(parseTasksBlock('limit: 5').errors.join(' ')).toContain('view')
  })
})

describe('pm-tasks block — saved views', () => {
  const views = [{ id: '1', name: 'My work', filter: filter(), sortKey: '', sortDir: 'asc' }] as SavedView[]

  it('reads the all-projects saved views out of settings', () => {
    expect(uberSavedViews({ '::all-projects': { savedViews: views } })).toHaveLength(1)
    expect(uberSavedViews({})).toEqual([])
    expect(uberSavedViews(undefined)).toEqual([])
  })

  it('matches the name case- and space-insensitively', () => {
    expect(findSavedView(views, '  my work ')?.id).toBe('1')
    expect(findSavedView(views, 'my other work')).toBeUndefined()
  })
})

describe('pm-tasks block — selection', () => {
  const mine = makeTask({ title: 'Mine', assignees: ['Jo'], due: '2026-09-02', status: 'todo' })
  const theirs = makeTask({ title: 'Theirs', assignees: ['Sam'], due: '2026-09-01', status: 'todo' })
  const sub = makeTask({ title: 'My subtask', assignees: ['Jo'], due: '2026-09-03', status: 'todo' })
  const parent = makeTask({ title: 'Parent', assignees: ['Sam'], status: 'todo', subtasks: [sub] })
  const undated = makeTask({ title: 'Someday', assignees: ['Jo'], status: 'todo' })

  const projects = [project('Alpha', [mine, theirs]), project('Beta', [parent, undated])]

  it("selects across every project, using the saved view's filter", () => {
    const rows = selectBlockTasks(projects, filter({ assignees: ['Jo'] }), DEFAULT_STATUSES)
    expect(rows.map((r) => r.task.title)).toEqual(['Mine', 'My subtask', 'Someday'])
  })

  it('counts a matching subtask on its own, even when its parent does not match', () => {
    const rows = selectBlockTasks(projects, filter({ assignees: ['Jo'] }), DEFAULT_STATUSES)
    expect(rows.map((r) => r.task.title)).toContain('My subtask')
    expect(rows.map((r) => r.task.title)).not.toContain('Parent')
  })

  it('orders by due date and puts undated work last', () => {
    // A panel is "what is coming up"; a task with no date isn't, so it sinks rather than
    // sorting as if it were due in year zero.
    const rows = selectBlockTasks(projects, filter(), DEFAULT_STATUSES)
    expect(rows.map((r) => r.task.title)).toEqual(['Theirs', 'Mine', 'My subtask', 'Parent', 'Someday'])
  })

  it('applies a limit after sorting, so the cap keeps the most urgent', () => {
    const rows = selectBlockTasks(projects, filter(), DEFAULT_STATUSES, 2)
    expect(rows.map((r) => r.task.title)).toEqual(['Theirs', 'Mine'])
  })

  it('keeps archived work out unless the saved view asks for it', () => {
    const archived = makeTask({ title: 'Old', assignees: ['Jo'], due: '2026-09-01' })
    archived.archived = true
    const ps = [project('Alpha', [archived])]
    expect(selectBlockTasks(ps, filter({ assignees: ['Jo'] }), DEFAULT_STATUSES)).toHaveLength(0)
    expect(selectBlockTasks(ps, filter({ assignees: ['Jo'], showArchived: true }), DEFAULT_STATUSES)).toHaveLength(1)
  })

  it('groups rows under their project, in the order the projects came in', () => {
    const rows = selectBlockTasks(projects, filter(), DEFAULT_STATUSES)
    const groups = groupByProject(rows)
    expect(groups.map((g) => g.project.title)).toEqual(['Alpha', 'Beta'])
    expect(groups[1].tasks.map((t) => t.title)).toEqual(['My subtask', 'Parent', 'Someday'])
  })
})
