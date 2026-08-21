import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, makeProject, makeTask, type PMSettings } from '../types'
import { projectRoster } from './roster'

const settings = (globalTeamMembers: string[] = []): PMSettings => ({ ...DEFAULT_SETTINGS, globalTeamMembers })

/*
 * Every view of a project resolves initials against this one set. The filter row used to
 * derive its own from task assignees alone, so a person with no colliding *assignee* read
 * as "EC" there and "EdC" everywhere else.
 */
describe('projectRoster', () => {
  it('counts team members who have no tasks, so views agree with the filter row', () => {
    const project = makeProject('Demo', 'Projects/Demo.md')
    project.teamMembers = ['Ed Coyne', 'Emma Clark'] // Emma has no task
    project.tasks = [makeTask({ title: 'Only Ed', assignees: ['Ed Coyne'] })]

    const roster = projectRoster(project, settings())

    expect(roster.get('Ed Coyne')).toBe('EdC')
    expect(roster.get('Emma Clark')).toBe('EmC')
  })

  it('counts the global team too', () => {
    const project = makeProject('Demo', 'Projects/Demo.md')
    project.tasks = [makeTask({ title: 'Only Ed', assignees: ['Ed Coyne'] })]

    const roster = projectRoster(project, settings(['Emma Clark']))

    expect(roster.get('Ed Coyne')).toBe('EdC')
  })

  it('leaves initials at two letters when nobody collides', () => {
    const project = makeProject('Demo', 'Projects/Demo.md')
    project.teamMembers = ['Ed Coyne', 'Grace Hopper']

    const roster = projectRoster(project, settings())

    expect(roster.get('Ed Coyne')).toBe('EC')
    expect(roster.get('Grace Hopper')).toBe('GH')
  })
})
