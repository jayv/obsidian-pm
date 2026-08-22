import { makeProject, makeTask, type Project } from '../types'
import { flattenTasks } from './TaskTreeOps'
import { buildTaskIndex } from './TaskIndex'

/** The virtual project's file path. Empty on purpose — see {@link buildUberProject}. */
export const UBER_PROJECT_PATH = ''

export interface UberProject {
  /**
   * One project holding every real project as a top-level task, with their tasks nested
   * beneath. Renders in the existing views unchanged, because it is a `Project`.
   */
  project: Project
  /** Which real project a task belongs to, by task id — the owner for any write. */
  ownerOf: Map<string, Project>
  /** The synthetic per-project rows, by task id. They are headings, not real tasks. */
  headings: Set<string>
  /** The real projects that went in, in the order their rows appear. */
  sources: Project[]
}

/**
 * Assemble the projects into one virtual project for a cross-project view.
 *
 * Deliberately not file-backed: `filePath` is empty, which `ProjectStore.saveProject`
 * already treats as "not a real project yet" and refuses to write. So a stray save can't
 * flatten several projects into one file — the failure mode that matters most here.
 *
 * Writes are meant to be delegated instead: resolve the owning project through `ownerOf`
 * and call the store with that. The tasks themselves are shared by reference with the
 * loaded projects, so an edit applied through the owner is visible here without rebuilding.
 *
 * Each real project contributes a synthetic parent row so the tree reads
 * "Project → Task → Subtask". Those rows are milestones-in-name-only: they carry no dates
 * and are listed in `headings` so views can treat them as headings rather than work.
 */
export function buildUberProject(projects: Project[]): UberProject {
  const ownerOf = new Map<string, Project>()
  const headings = new Set<string>()
  const sources = [...projects].sort((a, b) => a.title.localeCompare(b.title))

  const project = makeProject('All projects', UBER_PROJECT_PATH)
  project.icon = '🗂️'
  project.tasks = sources.map((source) => {
    // The heading's id has to be stable across rebuilds so collapse state survives a
    // refresh, and distinct from any task id — the project's own id gives both.
    const heading = makeTask({
      id: `uber:${source.id}`,
      title: source.title,
      start: '', // no dates of its own; the gantt rolls its span up from the children
      due: '',
      subtasks: source.tasks,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt
    })
    headings.add(heading.id)
    ownerOf.set(heading.id, source)
    for (const { task } of flattenTasks(source.tasks)) ownerOf.set(task.id, source)
    return heading
  })

  project.teamMembers = [...new Set(sources.flatMap((p) => p.teamMembers))].sort()
  project.taskIndex = buildTaskIndex(project.tasks)
  return { project, ownerOf, headings, sources }
}
