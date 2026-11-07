import { TFile, normalizePath } from 'obsidian'
import { fetchIssue, importStories, issueUnderRoot, jiraChildTypeFor, runSync } from './connectors/jira/sync'
import { defaultNewTaskSync } from './connectors/jira/taskLink'
import { projectCfg, taskExt } from './connectors/jira/types'
import type PMPlugin from './main'
import { findParentId, findTaskById } from './store/TaskIndex'
import { flattenTasks } from './store/TaskTreeOps'
import type { Project, Task, TaskPriority, ViewMode } from './types'
import { openTaskModal } from './ui/ModalFactory'
import type { ProjectView } from './views/ProjectView'

/**
 * Public API for other plugins. Reach it as
 * `app.plugins.plugins['project-manager'].api`. The contract is docs/api.md.
 *
 * Other plugins must go through here rather than editing task notes on disk:
 * the note body is the task description (pushed verbatim to Jira), the tree is
 * rebuilt from `subtaskIds`/`parent`, and every write has to pass the same
 * validation and dirty-tracking the views use.
 *
 * A task `ref` is either its vault path (`Projects/Foo_tasks/Bar.md`, `.md`
 * optional) or its id. Everything returned is a plain snapshot, never a live
 * store object.
 */

export type PMApiErrorCode =
  | 'not-found'
  | 'invalid'
  | 'jira-disabled'
  | 'jira-unreachable'
  | 'out-of-scope'
  | 'too-deep'
  | 'conflict'

/** Every refusal carries a stable `code`; the message is for humans. */
export class PMApiError extends Error {
  constructor(
    readonly code: PMApiErrorCode,
    message: string
  ) {
    super(`project-manager: ${message}`)
    this.name = 'PMApiError'
  }
}

export interface ProjectSnapshot {
  id: string
  title: string
  filePath: string
  taskCount: number
  /** null when the project has no enabled Jira connector. */
  jira: { serverId: string; rootKey: string } | null
}

export interface TaskSnapshot {
  id: string
  title: string
  description: string
  type: Task['type']
  status: string
  priority: TaskPriority
  start: string
  due: string
  progress: number
  completed: string
  assignees: string[]
  tags: string[]
  archived: boolean
  filePath: string | null
  parentId: string | null
  subtaskIds: string[]
  projectPath: string
  projectTitle: string
  /** null for a task not linked to a Jira issue. */
  jira: { key: string; sync: boolean; conflict: boolean } | null
}

/** The fields another plugin may change. Anything else is rejected. */
export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'start' | 'due' | 'progress' | 'assignees' | 'tags'>
>

export interface OpenTaskOpts {
  /** 'both' (default): project tab behind, editor in front. */
  where?: 'both' | 'project' | 'modal'
  view?: ViewMode
}

export interface SyncSummary {
  jiraCreated: number
  jiraUpdated: number
  obsidianUpdated: number
  conflicts: number
  /** Issue keys under the root that are not local tasks yet — offered, not imported. */
  newIssues: string[]
}

export interface ChangeEvent {
  kind: 'task' | 'project'
  projectPath: string
  taskId?: string
}

const PATCHABLE = new Set<keyof TaskPatch>([
  'title',
  'description',
  'status',
  'priority',
  'start',
  'due',
  'progress',
  'assignees',
  'tags'
])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

export class PluginApi {
  private listeners = new Set<(e: ChangeEvent) => void>()
  /** Task ids changed since the last save, per project path — drained into events on save. */
  private pendingTaskIds = new Map<string, Set<string>>()

  constructor(private readonly plugin: PMPlugin) {}

  // ─── read ──────────────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectSnapshot[]> {
    const projects = await this.projects()
    return projects.map(projectSnapshot)
  }

  /** Every task, or only those of the project at `projectPath`. */
  async listTasks(projectPath?: string): Promise<TaskSnapshot[]> {
    const wanted = projectPath === undefined ? null : notePath(projectPath)
    const out: TaskSnapshot[] = []
    for (const project of await this.projects()) {
      if (wanted !== null && project.filePath !== wanted) continue
      for (const { task } of flattenTasks(project.tasks)) out.push(snapshot(project, task))
    }
    return out
  }

  async getTask(ref: string): Promise<TaskSnapshot | null> {
    const hit = await this.resolve(ref)
    return hit ? snapshot(hit.project, hit.task) : null
  }

  // ─── write ─────────────────────────────────────────────────────────────────

  /**
   * Change fields on a task. Validates against plugin settings (status and
   * priority ids, date shape, progress range) and rejects unknown keys, so a
   * bad call fails loudly instead of writing a note the views can't read.
   */
  async updateTask(ref: string, patch: TaskPatch): Promise<TaskSnapshot> {
    const hit = await this.resolve(ref)
    if (!hit) throw new PMApiError('not-found', `no task for "${ref}"`)
    if (taskExt(hit.task).reconciled === false) {
      throw new PMApiError(
        'conflict',
        `"${hit.task.title}" is in a Jira conflict; resolve it in the merge editor first`
      )
    }
    const clean = this.validate(patch)
    await this.plugin.store.updateTask(hit.project, hit.task.id, clean)
    this.plugin.refreshProjectViews()
    return snapshot(hit.project, hit.task)
  }

  /**
   * Create a task in the project at `projectPath`, optionally under `parent` (a task
   * ref). In a Jira-enabled project the task syncs by default (created in Jira on the
   * next sync, like one made in the UI); `opts.sync: false` keeps it local.
   */
  async createTask(
    projectPath: string,
    fields: TaskPatch,
    parent?: string,
    opts: { sync?: boolean } = {}
  ): Promise<TaskSnapshot> {
    const project = await this.project(projectPath)
    if (!project) throw new PMApiError('not-found', `no project at "${projectPath}"`)
    let parentId: string | null = null
    if (parent !== undefined) {
      const hit = await this.resolve(parent)
      if (!hit || hit.project !== project) throw new PMApiError('not-found', `no task "${parent}" in ${project.title}`)
      parentId = hit.task.id
    }
    const clean = this.validate(fields)
    const task = await this.plugin.store.addTask(project, parentId)
    if (projectCfg(project)?.enabled && opts.sync !== false) defaultNewTaskSync(task, true)
    await this.plugin.store.updateTask(project, task.id, clean)
    this.plugin.refreshProjectViews()
    return snapshot(project, task)
  }

  // ─── jira ──────────────────────────────────────────────────────────────────

  /**
   * Import one Jira issue as a task, exactly as picking it in the import dialog would:
   * same field maps, description as the body, linked with the shadow baseline recorded.
   * Idempotent: an issue already imported is returned with `created: false`.
   *
   * Without `projectPath` the project whose Jira root is an ancestor of the issue is
   * used. Without `parent` the task nests under the issue's own Jira parent (or
   * top-level); with it, the task is placed there and the next sync moves the issue in
   * Jira too, as dragging the row would.
   */
  async importJiraIssue(
    issueKey: string,
    opts: { projectPath?: string; parent?: string } = {}
  ): Promise<{ task: TaskSnapshot; created: boolean }> {
    const key = issueKey.trim().toUpperCase()
    if (!ISSUE_KEY_RE.test(key)) throw new PMApiError('invalid', `"${issueKey}" is not a Jira issue key`)

    const named = opts.projectPath !== undefined ? await this.jiraProject(opts.projectPath) : null
    const candidates = named ? [named] : (await this.projects()).filter((p) => projectCfg(p)?.enabled)
    if (!candidates.length) throw new PMApiError('jira-disabled', 'no project has Jira enabled')

    // Already a task in a project we'd consider? Then it's that one, untouched.
    for (const p of candidates) {
      const existing = flattenTasks(p.tasks).find((f) => taskExt(f.task).key === key)
      if (existing) return { task: snapshot(p, existing.task), created: false }
    }

    const found = await this.locateIssue(key, candidates, named !== null)
    const { owner, issue } = found

    let parentId: string | null = null
    if (opts.parent !== undefined) {
      const hit = await this.resolve(opts.parent)
      if (!hit || hit.project !== owner) throw new PMApiError('not-found', `no task "${opts.parent}" in ${owner.title}`)
      const parentKey = taskExt(hit.task).key
      if (parentKey && !(await this.jiraCall(() => jiraChildTypeFor(this.plugin, owner, parentKey)))) {
        throw new PMApiError('too-deep', `Jira has no issue type below ${parentKey}; ${key} can't nest there`)
      }
      parentId = hit.task.id
    }

    await this.jiraCall(() => importStories(this.plugin, owner, [issue]))
    const made = flattenTasks(owner.tasks).find((f) => taskExt(f.task).key === key)?.task
    if (!made) throw new PMApiError('jira-unreachable', `${key} was not imported`)
    if (opts.parent !== undefined && findParentId(owner, made.id) !== parentId) {
      await this.plugin.store.moveTask(owner, made.id, parentId)
    }
    this.plugin.refreshProjectViews()
    return { task: snapshot(owner, made), created: true }
  }

  /** A full sync now, silently: no progress popup, no import or merge dialog. */
  async syncProject(projectPath: string): Promise<SyncSummary> {
    const project = await this.jiraProject(projectPath)
    const r = await this.jiraCall(() => runSync(this.plugin, project, { full: true }))
    this.plugin.refreshProjectViews()
    return {
      jiraCreated: r.jiraCreated,
      jiraUpdated: r.jiraUpdated,
      obsidianUpdated: r.obsidianUpdated,
      conflicts: r.conflicts,
      newIssues: r.newIssues.map((i) => i.key)
    }
  }

  // ─── ui ────────────────────────────────────────────────────────────────────

  /**
   * Show a task. 'modal' opens the editor over whatever is open; 'project' opens or
   * reveals the project tab with the row highlighted; 'both' (default) does the second
   * then the first, so closing the editor leaves the user on the row. False when the
   * ref is unknown.
   */
  async openTask(ref: string, opts: OpenTaskOpts = {}): Promise<boolean> {
    const hit = await this.resolve(ref)
    if (!hit) return false
    const { project, task } = hit
    const where = opts.where ?? 'both'
    if (where !== 'modal') {
      const view = await this.openProjectTab(project)
      if (view) await view.revealTask(task.id, opts.view)
    }
    if (where !== 'project') {
      openTaskModal(this.plugin, project, {
        task,
        onSave: async () => {
          await this.plugin.store.saveProject(project)
          this.plugin.refreshProjectViews()
        }
      })
    }
    return true
  }

  /** Open or reveal the project's tab, optionally on a given sub-view. False when unknown. */
  async openProject(projectPath: string, opts: { view?: ViewMode } = {}): Promise<boolean> {
    const project = await this.project(projectPath)
    if (!project) return false
    const view = await this.openProjectTab(project)
    if (view && opts.view) view.setView(opts.view)
    return true
  }

  // ─── events ────────────────────────────────────────────────────────────────

  /**
   * Called after every save the plugin makes — from the UI, a sync or this API — with
   * one event per changed task, or a 'project' event when only the project changed.
   * Returns the unsubscribe function.
   */
  onChange(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Store hook: a task changed in memory; the event waits for the save. */
  noteTaskChanged(project: Project, task: Task): void {
    let ids = this.pendingTaskIds.get(project.filePath)
    if (!ids) this.pendingTaskIds.set(project.filePath, (ids = new Set()))
    ids.add(task.id)
  }

  /** Store hook: the project was written; flush what changed since the last save. */
  noteProjectSaved(project: Project): void {
    const ids = this.pendingTaskIds.get(project.filePath)
    this.pendingTaskIds.delete(project.filePath)
    const events: ChangeEvent[] = ids?.size
      ? [...ids].map((taskId) => ({ kind: 'task' as const, projectPath: project.filePath, taskId }))
      : [{ kind: 'project', projectPath: project.filePath }]
    for (const e of events) {
      for (const listener of this.listeners) {
        try {
          listener(e)
        } catch (err) {
          console.error('[PM] api.onChange listener failed', err)
        }
      }
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private projects(): Promise<Project[]> {
    return this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
  }

  private async project(path: string): Promise<Project | null> {
    const wanted = notePath(path)
    return (await this.projects()).find((p) => p.filePath === wanted) ?? null
  }

  private async jiraProject(path: string): Promise<Project> {
    const project = await this.project(path)
    if (!project) throw new PMApiError('not-found', `no project at "${path}"`)
    if (!projectCfg(project)?.enabled) {
      throw new PMApiError('jira-disabled', `${project.title} has no Jira connector enabled`)
    }
    return project
  }

  /**
   * The issue and the candidate project whose root contains it. With a named project
   * an issue outside its root is 'out-of-scope'; otherwise the first containing project wins.
   */
  private async locateIssue(
    key: string,
    candidates: Project[],
    named: boolean
  ): Promise<{ owner: Project; issue: NonNullable<Awaited<ReturnType<typeof fetchIssue>>> }> {
    let seen = false
    for (const p of candidates) {
      const issue = await this.jiraCall(() => fetchIssue(this.plugin, p, key))
      if (!issue) continue
      seen = true
      if (await this.jiraCall(() => issueUnderRoot(this.plugin, p, issue))) return { owner: p, issue }
      if (named) {
        throw new PMApiError('out-of-scope', `${key} is not under ${p.title}'s Jira root ${projectCfg(p)?.epicId}`)
      }
    }
    if (!seen) throw new PMApiError('not-found', `no Jira issue ${key}`)
    throw new PMApiError('not-found', `no project's Jira root contains ${key}`)
  }

  /** Run a connector call; a transport failure becomes 'jira-unreachable' with the reason. */
  private async jiraCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof PMApiError) throw err
      throw new PMApiError('jira-unreachable', err instanceof Error ? err.message : String(err))
    }
  }

  private async openProjectTab(project: Project): Promise<ProjectView | null> {
    const file = this.plugin.app.vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) return null
    return this.plugin.router.openProjectView(file)
  }

  private async resolve(ref: string): Promise<{ project: Project; task: Task } | null> {
    const projects = await this.projects()
    const path = notePath(ref)
    for (const project of projects) {
      for (const { task } of flattenTasks(project.tasks)) {
        if (task.filePath === path) return { project, task }
      }
    }
    for (const project of projects) {
      const task = findTaskById(project, ref)
      if (task) return { project, task }
    }
    return null
  }

  private validate(patch: TaskPatch): TaskPatch {
    const clean: TaskPatch = {}
    const settings = this.plugin.settings
    const bad = (msg: string): never => {
      throw new PMApiError('invalid', msg)
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!PATCHABLE.has(key as keyof TaskPatch)) bad(`"${key}" is not a patchable field`)
      switch (key) {
        case 'title': {
          if (typeof value !== 'string' || !value.trim()) bad('title must be a non-empty string')
          clean.title = (value as string).trim()
          break
        }
        case 'description': {
          if (typeof value !== 'string') bad('description must be a string')
          clean.description = value as string
          break
        }
        case 'status': {
          const ids = settings.statuses.map((s) => s.id)
          if (typeof value !== 'string' || !ids.includes(value)) bad(`status must be one of ${ids.join(', ')}`)
          clean.status = value as string
          break
        }
        case 'priority': {
          const ids = settings.priorities.map((p) => p.id)
          if (typeof value !== 'string' || !ids.includes(value as TaskPriority)) {
            bad(`priority must be one of ${ids.join(', ')}`)
          }
          clean.priority = value as TaskPriority
          break
        }
        case 'start':
        case 'due': {
          if (typeof value !== 'string' || (value !== '' && !DATE_RE.test(value))) {
            bad(`${key} must be YYYY-MM-DD or ""`)
          }
          clean[key] = value as string
          break
        }
        case 'progress': {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
            bad('progress must be an integer 0-100')
          }
          clean.progress = value as number
          break
        }
        case 'assignees':
        case 'tags': {
          if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) bad(`${key} must be a list of strings`)
          clean[key] = (value as string[]).map((v) => v.trim()).filter(Boolean)
          break
        }
      }
    }
    return clean
  }
}

function notePath(ref: string): string {
  const p = normalizePath(ref)
  return p.endsWith('.md') ? p : `${p}.md`
}

function projectSnapshot(project: Project): ProjectSnapshot {
  const cfg = projectCfg(project)
  return {
    id: project.id,
    title: project.title,
    filePath: project.filePath,
    taskCount: flattenTasks(project.tasks).length,
    jira: cfg?.enabled ? { serverId: cfg.serverId, rootKey: cfg.epicId } : null
  }
}

function snapshot(project: Project, task: Task): TaskSnapshot {
  const ext = taskExt(task)
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    type: task.type,
    status: task.status,
    priority: task.priority,
    start: task.start,
    due: task.due,
    progress: task.progress,
    completed: task.completed,
    assignees: [...task.assignees],
    tags: [...task.tags],
    archived: task.archived ?? false,
    filePath: task.filePath ?? null,
    parentId: findParentId(project, task.id),
    subtaskIds: task.subtasks.map((s) => s.id),
    projectPath: project.filePath,
    projectTitle: project.title,
    jira: ext.key ? { key: ext.key, sync: ext.sync === true, conflict: ext.reconciled === false } : null
  }
}
