import type { StatusConfig, Task } from '../types'
import { makeId } from '../types'
import { isTerminalStatus } from '../utils'

/** Flatten a task tree into a list, preserving depth info */
export interface FlatTask {
  task: Task
  depth: number
  parentId: string | null
  visible: boolean
}

export function flattenTasks(
  tasks: Task[],
  depth = 0,
  parentId: string | null = null,
  ancestorCollapsed = false
): FlatTask[] {
  const result: FlatTask[] = []
  for (const task of tasks) {
    const visible = !ancestorCollapsed
    result.push({ task, depth, parentId, visible })
    if (task.subtasks.length > 0) {
      result.push(...flattenTasks(task.subtasks, depth + 1, task.id, ancestorCollapsed || task.collapsed))
    }
  }
  return result
}

/** Find a task anywhere in the tree by id */
export function findTask(tasks: Task[], id: string): Task | null {
  for (const t of tasks) {
    if (t.id === id) return t
    const found = findTask(t.subtasks, id)
    if (found) return found
  }
  return null
}

/** Structural equality for the plain data a task field holds (scalars, arrays, ext bags). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const av = a as Record<string, unknown>
    const bv = b as Record<string, unknown>
    const ak = Object.keys(av)
    if (ak.length !== Object.keys(bv).length) return false
    return ak.every((k) => sameValue(av[k], bv[k]))
  }
  return false
}

/**
 * Fields a patch may never carry. `subtasks` is the tree's shape, not one of the task's
 * values, and changing shape is what insertTask/moveTask/deleteTask are for.
 *
 * Callers hand over whole task objects — the editor clones the task it was given, and in
 * the gantt that task is a FILTERED copy whose `subtasks` hold only the children that
 * passed the filter. Assigning that over the real list silently disowns the rest: their
 * notes still name this parent, so they survive on disk and the loader re-adopts them, but
 * they vanish from every view until something reloads, and the parent's own note goes out
 * with a short list. `id` is here for the same reason — a patch that renames a task's
 * identity is a bug, never an intent.
 */
const STRUCTURAL: (keyof Task)[] = ['subtasks', 'id']

function withoutStructure(patch: Partial<Task>): Partial<Task> {
  if (!STRUCTURAL.some((k) => k in patch)) return patch
  const out = { ...patch }
  for (const key of STRUCTURAL) Reflect.deleteProperty(out, key)
  return out
}

/**
 * Does this patch actually change the task? A patch that restates what the task already
 * says is not an edit, and treating it as one costs more than a wasted write.
 *
 * `updatedAt` is a wall-clock stamp of when THIS machine wrote the file. A vault shared
 * between machines (git sync, Syncthing) has each of them deriving the same state from the
 * same remote at different moments — so a no-op rewrite gives two byte-different files
 * that differ only in that stamp, which is a merge conflict git cannot resolve and a
 * ping-pong once it is. Any Jira-side activity bumps an issue's `updated`, so this
 * happened for every touched task on every sync, whether or not anything about it changed.
 */
export function changesTask(task: Task, patch: Partial<Task>): boolean {
  const fields = withoutStructure(patch)
  return (Object.keys(fields) as (keyof Task)[]).some((key) => !sameValue(task[key], fields[key]))
}

/** Mutate task tree: update a task by id */
export function updateTaskInTree(tasks: Task[], id: string, patch: Partial<Task>): boolean {
  for (const t of tasks) {
    if (t.id === id) {
      // A patch may carry its own `updatedAt` — when the change came from elsewhere, that
      // source's timestamp describes it better than this machine's clock, and every vault
      // deriving the change writes the same bytes for it. Otherwise it's a local edit and
      // now() is exactly right.
      if (changesTask(t, patch)) {
        Object.assign(t, withoutStructure(patch), { updatedAt: patch.updatedAt ?? new Date().toISOString() })
      }
      return true
    }
    if (updateTaskInTree(t.subtasks, id, patch)) return true
  }
  return false
}

/** Mutate task tree: delete a task by id */
export function deleteTaskFromTree(tasks: Task[], id: string): boolean {
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].id === id) {
      tasks.splice(i, 1)
      return true
    }
    if (deleteTaskFromTree(tasks[i].subtasks, id)) return true
  }
  return false
}

/** Add a subtask under a parent; or top-level if parentId is null */
export function addTaskToTree(tasks: Task[], newTask: Task, parentId: string | null): void {
  if (!parentId) {
    tasks.push(newTask)
    return
  }
  const parent = findTask(tasks, parentId)
  if (parent) parent.subtasks.push(newTask)
  else tasks.push(newTask)
}

/**
 * Deep-clone a task subtree with fresh ids, timestamps, and no file paths.
 * When includeSubtasks is false, the clone has no children and its dependencies
 * are copied verbatim (they still point at originals in the project).
 * When includeSubtasks is true, the whole subtree is cloned and dependencies
 * that target another node within the subtree are remapped to the new ids;
 * dependencies pointing outside the subtree are preserved as-is.
 */
export function cloneTaskSubtree(source: Task, includeSubtasks: boolean): Task {
  const idMap = new Map<string, string>()
  const clone = cloneNode(source, includeSubtasks, idMap)
  if (includeSubtasks) remapDeps(clone, idMap)
  return clone
}

function cloneNode(source: Task, includeSubtasks: boolean, idMap: Map<string, string>): Task {
  const now = new Date().toISOString()
  const newId = makeId()
  idMap.set(source.id, newId)
  return {
    ...source,
    id: newId,
    filePath: undefined,
    createdAt: now,
    updatedAt: now,
    collapsed: false,
    subtasks: includeSubtasks ? source.subtasks.map((s) => cloneNode(s, true, idMap)) : [],
    dependencies: [...source.dependencies],
    assignees: [...source.assignees],
    tags: [...source.tags],
    customFields: { ...source.customFields },
    timeLogs: source.timeLogs ? source.timeLogs.map((l) => ({ ...l })) : undefined,
    recurrence: source.recurrence ? { ...source.recurrence } : undefined
  }
}

function remapDeps(task: Task, idMap: Map<string, string>): void {
  task.dependencies = task.dependencies.map((id) => idMap.get(id) ?? id)
  for (const sub of task.subtasks) remapDeps(sub, idMap)
}

/** Move a task before or after another task in the tree (same level) */
export function moveTaskInTree(tasks: Task[], taskId: string, targetId: string, position: 'before' | 'after'): boolean {
  // Try at this level first
  const taskIdx = tasks.findIndex((t) => t.id === taskId)
  const targetIdx = tasks.findIndex((t) => t.id === targetId)
  if (taskIdx !== -1 && targetIdx !== -1) {
    const [task] = tasks.splice(taskIdx, 1)
    const insertIdx = tasks.findIndex((t) => t.id === targetId)
    tasks.splice(position === 'before' ? insertIdx : insertIdx + 1, 0, task)
    return true
  }
  // Recurse into subtasks
  for (const t of tasks) {
    if (moveTaskInTree(t.subtasks, taskId, targetId, position)) return true
  }
  return false
}

/** Filter archived tasks from a task tree (returns a shallow copy) */
export function filterArchived(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => !t.archived)
    .map((t) => (t.subtasks.length ? { ...t, subtasks: filterArchived(t.subtasks) } : t))
}

/** Collect all unique assignees from a task tree */
/**
 * How many tasks in the tree, or how many of them are finished. Counts every level, not
 * just leaves — the same number the dashboard card shows and the timeline's project dial
 * fills to, so the two can't disagree.
 */
export function countTasks(tasks: Task[], doneOnly: boolean, statuses: StatusConfig[]): number {
  let n = 0
  for (const t of tasks) {
    if (!doneOnly || isTerminalStatus(t.status, statuses)) n++
    n += countTasks(t.subtasks, doneOnly, statuses)
  }
  return n
}

export function collectAllAssignees(tasks: Task[], extra?: string[]): string[] {
  const set = new Set<string>()
  if (extra) for (const m of extra) set.add(m)
  const walk = (list: Task[]) => {
    for (const t of list) {
      for (const a of t.assignees) set.add(a)
      walk(t.subtasks)
    }
  }
  walk(tasks)
  return [...set].filter(Boolean).sort()
}

/** Collect all unique tags from a task tree */
export function collectAllTags(tasks: Task[]): string[] {
  const set = new Set<string>()
  const walk = (list: Task[]) => {
    for (const t of list) {
      for (const tag of t.tags) set.add(tag)
      walk(t.subtasks)
    }
  }
  walk(tasks)
  return [...set].filter(Boolean).sort()
}

/**
 * Earliest start and latest due across all of a task's descendants (any depth).
 * Each YYYY-MM-DD endpoint — start and due — is considered, so a sub with only
 * one date still contributes. Returns empty strings when no descendant is dated.
 * Used to render a parent as a summary bar spanning its subtasks.
 */
export function subtaskDateSpan(task: Task): { start: string; due: string } {
  let start = ''
  let due = ''
  const consider = (d: string): void => {
    if (!d) return
    if (!start || d < start) start = d
    if (!due || d > due) due = d
  }
  const walk = (list: Task[]): void => {
    for (const t of list) {
      consider(t.start)
      consider(t.due)
      walk(t.subtasks)
    }
  }
  walk(task.subtasks)
  return { start, due }
}

/**
 * Rewrite every parent task's start/due in place to span its dated descendants
 * (see {@link subtaskDateSpan}), bottom-up so nested parents resolve correctly.
 * Parents with no dated descendants keep their own dates. Returns the ids of the
 * tasks whose dates changed, so callers can persist exactly those.
 */
export function rollUpParentDates(tasks: Task[]): string[] {
  const changed: string[] = []
  const recurse = (task: Task): { start: string; due: string } => {
    if (task.subtasks.length === 0) return { start: task.start, due: task.due }
    let lo = ''
    let hi = ''
    const consider = (d: string): void => {
      if (!d) return
      if (!lo || d < lo) lo = d
      if (!hi || d > hi) hi = d
    }
    for (const sub of task.subtasks) {
      const r = recurse(sub)
      consider(r.start)
      consider(r.due)
    }
    if (!lo && !hi) return { start: task.start, due: task.due }
    const newStart = lo || hi
    const newDue = hi || lo
    if (task.start !== newStart || task.due !== newDue) {
      task.start = newStart
      task.due = newDue
      changed.push(task.id)
    }
    return { start: newStart, due: newDue }
  }
  for (const t of tasks) recurse(t)
  return changed
}

/** Sum all logged hours for a task */
export function totalLoggedHours(task: Task): number {
  if (!task.timeLogs?.length) return 0
  return task.timeLogs.reduce((sum, log) => sum + log.hours, 0)
}
