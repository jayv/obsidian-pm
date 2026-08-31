import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeProject, makeTask } from '../types'
import type { FilterState, Project, SavedView } from '../types'
import {
  blockRoster,
  findSavedView,
  groupByProject,
  parseTasksBlock,
  resolveBlock,
  selectBlockTasks,
  uberSavedViews
} from './tasksBlock'

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

  it('reads a project scope', () => {
    expect(parseTasksBlock('project: Athlon\nview: Blocked').project).toBe('Athlon')
  })
})

describe('pm-tasks block — resolution', () => {
  const uberView = { id: 'u', name: 'My work', filter: filter({ assignees: ['Jo'] }), sortKey: '', sortDir: 'asc' }
  const ownView = { id: 'p', name: 'Blocked', filter: filter({ statuses: ['blocked'] }), sortKey: '', sortDir: 'asc' }
  const alpha = project('Alpha', [makeTask({ title: 'a' })])
  const beta = project('Beta', [makeTask({ title: 'b' })])
  alpha.savedViews = [ownView as SavedView]
  const settings = { '::all-projects': { savedViews: [uberView as SavedView] } }

  it('reads the all-projects views and scans everything when no project is named', () => {
    const r = resolveBlock(parseTasksBlock('view: My work'), [alpha, beta], settings)
    expect(r.errors).toEqual([])
    expect(r.projects.map((p) => p.title)).toEqual(['Alpha', 'Beta'])
    expect(r.filter.assignees).toEqual(['Jo'])
    expect(r.title).toBe('My work')
  })

  it("reads the project's OWN saved views, and scopes to it, when one is named", () => {
    // Saved views belong to a project; the all-projects timeline is the exception that
    // keeps its own in settings. `project:` picks the namespace as well as the scope.
    const r = resolveBlock(parseTasksBlock('project: Alpha\nview: Blocked'), [alpha, beta], settings)
    expect(r.errors).toEqual([])
    expect(r.projects.map((p) => p.title)).toEqual(['Alpha'])
    expect(r.filter.statuses).toEqual(['blocked'])
  })

  it('does not find a project view from the all-projects namespace, or the reverse', () => {
    expect(resolveBlock(parseTasksBlock('view: Blocked'), [alpha, beta], settings).errors.join(' ')).toContain(
      'Blocked'
    )
    expect(
      resolveBlock(parseTasksBlock('project: Alpha\nview: My work'), [alpha, beta], settings).errors.join(' ')
    ).toContain('My work')
  })

  it('matches the project by title or by note path', () => {
    expect(resolveBlock(parseTasksBlock('project: alpha'), [alpha, beta], settings).projects).toHaveLength(1)
    expect(resolveBlock(parseTasksBlock('project: Projects/Alpha.md'), [alpha, beta], settings).projects).toHaveLength(
      1
    )
  })

  it('shows the whole project when it is named without a view', () => {
    const r = resolveBlock(parseTasksBlock('project: Beta'), [alpha, beta], settings)
    expect(r.errors).toEqual([])
    expect(r.projects.map((p) => p.title)).toEqual(['Beta'])
    expect(r.title).toBe('Beta')
  })

  it('needs a view when no project is named', () => {
    expect(resolveBlock(parseTasksBlock('limit: 5'), [alpha, beta], settings).errors.join(' ')).toContain('view')
  })

  it('lists the valid names for whatever was wrong', () => {
    const missingProject = resolveBlock(parseTasksBlock('project: Gamma\nview: x'), [alpha, beta], settings)
    expect(missingProject.available).toEqual(['Alpha', 'Beta'])
    const missingView = resolveBlock(parseTasksBlock('project: Alpha\nview: Nope'), [alpha, beta], settings)
    expect(missingView.available).toEqual(['Blocked'])
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

  it('orders by due date within a level, keeping a parent above its own rows', () => {
    // A panel is "what is coming up", so undated work sinks. But the ordering is per
    // level, not global: a kept parent has to stay adjacent to its sub-tasks or the
    // indentation reads as nonsense (here 'My subtask' is due before 'Parent' has a date
    // at all, yet must stay under it).
    const rows = selectBlockTasks(projects, filter(), DEFAULT_STATUSES)
    expect(rows.map((r) => r.task.title)).toEqual(['Theirs', 'Mine', 'Parent', 'My subtask', 'Someday'])
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 0, 1, 0])
  })

  it('drops a matching parent when none of its sub-tasks match', () => {
    // A container row is a heading, and a panel of headings is not a list of what to do.
    const child = makeTask({ title: 'Not mine', assignees: ['Sam'], status: 'todo' })
    const container = makeTask({ title: 'Container', assignees: ['Jo'], status: 'todo', subtasks: [child] })
    const rows = selectBlockTasks([project('Alpha', [container])], filter({ assignees: ['Jo'] }), DEFAULT_STATUSES)
    expect(rows).toHaveLength(0)
  })

  it('keeps a matching parent when a sub-task matches, nested under it', () => {
    const child = makeTask({ title: 'Mine', assignees: ['Jo'], status: 'todo' })
    const container = makeTask({ title: 'Container', assignees: ['Jo'], status: 'todo', subtasks: [child] })
    const rows = selectBlockTasks([project('Alpha', [container])], filter({ assignees: ['Jo'] }), DEFAULT_STATUSES)
    expect(rows.map((r) => [r.task.title, r.depth])).toEqual([
      ['Container', 0],
      ['Mine', 1]
    ])
  })

  it('lifts a matching sub-task whose parent was not kept', () => {
    // The child matched; why its parent isn't shown is none of its business.
    const child = makeTask({ title: 'Mine', assignees: ['Jo'], status: 'todo' })
    const container = makeTask({ title: 'Container', assignees: ['Sam'], status: 'todo', subtasks: [child] })
    const rows = selectBlockTasks([project('Alpha', [container])], filter({ assignees: ['Jo'] }), DEFAULT_STATUSES)
    expect(rows.map((r) => [r.task.title, r.depth])).toEqual([['Mine', 0]])
  })

  it('drops a parent whose only surviving child is itself an empty container', () => {
    // Bottom-up: the grandchild fails, so the middle container goes, so the top one has
    // nothing under it either.
    const grandchild = makeTask({ title: 'Theirs', assignees: ['Sam'], status: 'todo' })
    const middle = makeTask({ title: 'Middle', assignees: ['Jo'], status: 'todo', subtasks: [grandchild] })
    const top = makeTask({ title: 'Top', assignees: ['Jo'], status: 'todo', subtasks: [middle] })
    const rows = selectBlockTasks([project('Alpha', [top])], filter({ assignees: ['Jo'] }), DEFAULT_STATUSES)
    expect(rows).toHaveLength(0)
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

  it('leaves milestones out — a marker on a timeline is not something you do', () => {
    // In the chart a milestone is a diamond, so it reads as a marker. Dropped into a list
    // of tasks it looks exactly like one, which is what made it confusing.
    const milestone = makeTask({ title: 'Launch', type: 'milestone', due: '2026-09-01', assignees: ['Jo'] })
    const task = makeTask({ title: 'Real work', due: '2026-09-02', assignees: ['Jo'] })
    const rows = selectBlockTasks([project('Alpha', [milestone, task])], filter(), DEFAULT_STATUSES)
    expect(rows.map((r) => r.task.title)).toEqual(['Real work'])
  })

  it('does not keep a parent alive on the strength of a milestone child', () => {
    const milestone = makeTask({ title: 'Launch', type: 'milestone', due: '2026-09-01' })
    const container = makeTask({ title: 'Container', subtasks: [milestone] })
    expect(selectBlockTasks([project('Alpha', [container])], filter(), DEFAULT_STATUSES)).toHaveLength(0)
  })

  it('gives one person the same initials whichever project their row came from', () => {
    // Two rosters would happily disagree with each other inside a single list.
    const a = project('Alpha', [makeTask({ title: 'x', assignees: ['Jo Voordeckers'] })])
    const b = project('Beta', [makeTask({ title: 'y', assignees: ['Jo Voordeckers', 'Jo Vance'] })])
    const roster = blockRoster([a, b], [])
    expect(roster.get('Jo Voordeckers')).toBeTruthy()
    expect(roster.get('Jo Voordeckers')).not.toBe(roster.get('Jo Vance'))
  })

  it('groups rows under their project, in the order the projects came in', () => {
    const rows = selectBlockTasks(projects, filter(), DEFAULT_STATUSES)
    const groups = groupByProject(rows)
    expect(groups.map((g) => g.project.title)).toEqual(['Alpha', 'Beta'])
    expect(groups[1].rows.map((r) => r.task.title)).toEqual(['Parent', 'My subtask', 'Someday'])
  })
})
