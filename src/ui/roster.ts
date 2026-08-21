import type { PMSettings, Project } from '../types'
import { collectAllAssignees } from '../store/TaskTreeOps'
import { initialsRoster } from './primitives/Avatar'

/**
 * Avatar initials for everyone a project knows about — team members, the global team, and
 * anyone assigned to a task.
 *
 * Every view of a project renders against this one set, so a person's initials are the
 * same on the board, the table, the chart and the filter row. Computing it per task or per
 * row instead would let the same person show as "JD" in one place and "JaD" in another.
 */
export function projectRoster(project: Project, settings: PMSettings): Map<string, string> {
  return initialsRoster(collectAllAssignees(project.tasks, [...project.teamMembers, ...settings.globalTeamMembers]))
}
