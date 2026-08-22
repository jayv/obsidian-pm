/* Test harness for the JIRA connector: a fake plugin/store over an in-memory vault,
 * so sync.ts orchestration can be driven end-to-end against the real in-process
 * JiraMockServer over HTTP (real client, real parse/persist paths). */
import type PMPlugin from '../../main'
import type { Project, Task } from '../../types'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, makeProject, makeTask } from '../../types'
import { addTaskToTree, flattenTasks, updateTaskInTree } from '../../store/TaskTreeOps'
import type { ProjectStore } from '../../store/ProjectStore'
import { loadMock, saveMock, type JiraMockStore, type MockIssueRecord } from './JiraMock'
import { assigneeMapFor, ensureProjectCfg, ensureTaskExt, type JiraAssignee, type JiraProjectConfig } from './types'

/** The exact ProjectStore surface the connector relies on. Binding the fake to this
 *  means a signature change in ProjectStore breaks the build — catching core↔connector
 *  drift at compile time. Keep in sync with the methods sync.ts/the panel call. */
type ConnectorStore = Pick<
  ProjectStore,
  | 'applyExternalUpdates'
  | 'importTasks'
  | 'saveProject'
  | 'ensureCreated'
  | 'loadAllProjects'
  | 'renameAssignee'
  | 'loadTaskBody'
>

/** A clearly-future JIRA timestamp, for simulating teammate edits past any watermark. */
export const FUTURE = '2099-01-01T00:00:00.000+0000'

/** In-memory vault adapter (the slice of Obsidian's adapter that loadMock/saveMock use). */
export class FakeAdapter {
  files = new Map<string, string>()
  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p))
  }
  read(p: string): Promise<string> {
    return Promise.resolve(this.files.get(p) ?? '')
  }
  write(p: string, data: string): Promise<void> {
    this.files.set(p, data)
    return Promise.resolve()
  }
}

/** Minimal store: applies the same tree ops the real ProjectStore uses, no file IO.
 *  `implements ConnectorStore` ties it to ProjectStore's real signatures. */
class FakeStore implements ConnectorStore {
  /** Every project `connect()` made, so cross-project fan-out has something to walk. */
  readonly projects: Project[] = []
  loadAllProjects(folder: string): Promise<Project[]> {
    void folder
    return Promise.resolve(this.projects)
  }
  /** Harness tasks live in memory, so their description is already whatever it is. */
  loadTaskBody(task: Task): Promise<void> {
    void task
    return Promise.resolve()
  }
  /** Mirrors ProjectStore.renameAssignee: the member slot plus every task naming them. */
  renameAssignee(project: Project, from: string, to: string): number {
    const at = project.teamMembers.indexOf(from)
    if (at >= 0) {
      if (!to || project.teamMembers.includes(to)) project.teamMembers.splice(at, 1)
      else project.teamMembers[at] = to
    }
    if (!from || from === to) return 0
    let changed = 0
    for (const { task } of flattenTasks(project.tasks)) {
      if (!task.assignees.includes(from)) continue
      const kept = task.assignees.filter((n) => n !== from)
      task.assignees = to && !kept.includes(to) ? [...kept, to] : kept
      changed++
    }
    return changed
  }

  applyExternalUpdates(project: Project, entries: { taskId: string; patch: Partial<Task> }[]): Promise<void> {
    for (const { taskId, patch } of entries) updateTaskInTree(project.tasks, taskId, patch)
    return Promise.resolve()
  }
  importTasks(project: Project, entries: { task: Task; parentId: string | null }[]): Promise<void> {
    for (const { task, parentId } of entries) addTaskToTree(project.tasks, task, parentId)
    return Promise.resolve()
  }
  saveProject(project: Project): Promise<void> {
    void project
    return Promise.resolve()
  }
  ensureCreated(project: Project, folder: string): Promise<string> {
    void folder
    return Promise.resolve(project.filePath) // harness projects always have a path
  }
}

/** Build a fake plugin wired to a localhost JIRA server (routes to the in-process mock). */
export function harness(opts: { team?: string[]; adapter?: FakeAdapter } = {}): {
  plugin: PMPlugin
  adapter: FakeAdapter
} {
  const adapter = opts.adapter ?? new FakeAdapter()
  const plugin = {
    app: { vault: { adapter } },
    manifest: { dir: 'plugins/pm' },
    settings: {
      statuses: DEFAULT_STATUSES,
      priorities: DEFAULT_PRIORITIES,
      globalTeamMembers: opts.team ?? [],
      connectors: { jira: { servers: [{ id: 's1', name: 'Mock', site: 'localhost', email: 'me@x' }] } },
      connectorSecrets: {}
    },
    store: new FakeStore(),
    refreshProjectViews() {},
    // Assignee mappings live in plugin settings, so sync persists them through here.
    saveSettings: () => Promise.resolve()
  } as unknown as PMPlugin
  return { plugin, adapter }
}

/** The server-wide assignee map for a harness plugin — where mappings actually live. */
export function sharedMap(plugin: PMPlugin): JiraAssignee[] {
  return assigneeMapFor(plugin, 's1')
}

/** Create an enabled JIRA project bound to the mock server + an epic key. */
export function connect(
  plugin: PMPlugin,
  opts: { team?: string[]; epicId?: string; title?: string } = {}
): { project: Project; cfg: JiraProjectConfig } {
  const project = makeProject(opts.title ?? 'Demo Project', `Projects/${opts.title ?? 'Demo'}.md`)
  project.teamMembers = opts.team ?? []
  const cfg = ensureProjectCfg(project)
  cfg.enabled = true
  cfg.serverId = 's1'
  cfg.epicId = opts.epicId ?? 'DEMO-100'
  ;(plugin.store as unknown as FakeStore).projects.push(project)
  return { project, cfg }
}

/** Status/priority maps keyed to the default settings labels the mock seeds from. */
export function setDefaultMaps(cfg: JiraProjectConfig): void {
  cfg.statusMap = [
    { jira: 'To Do', target: 'todo', outbound: true },
    { jira: 'In Progress', target: 'in-progress', outbound: true },
    { jira: 'Blocked', target: 'blocked', outbound: true },
    { jira: 'In Review', target: 'review', outbound: true },
    { jira: 'Done', target: 'done', outbound: true },
    { jira: 'Cancelled', target: 'cancelled', outbound: true }
  ]
  cfg.priorityMap = [
    { jira: 'Critical', target: 'critical', outbound: true },
    { jira: 'High', target: 'high', outbound: true },
    { jira: 'Medium', target: 'medium', outbound: true },
    { jira: 'Low', target: 'low', outbound: true }
  ]
}

/** Add a local task to the project tree (no JIRA key). */
export function localTask(project: Project, overrides: Partial<Task> = {}, parentId: string | null = null): Task {
  const t = makeTask({ start: '', due: '', ...overrides })
  addTaskToTree(project.tasks, t, parentId)
  return t
}

/** Mark a task opted-in for sync (sync === true). */
export function optIn(task: Task): Task {
  ensureTaskExt(task).sync = true
  return task
}

/** Load → mutate → persist the mock DB, simulating a teammate change / hand-edit. */
export async function mutateMock(plugin: PMPlugin, fn: (store: JiraMockStore) => void): Promise<void> {
  const store = await loadMock(plugin, 'DEMO')
  fn(store)
  await saveMock(plugin, store)
}

/**
 * Seed a parent→child CHAIN of issues into the mock under `parentKey`: one issue per
 * name, each the `parent` of the next. Models a deep hierarchy (Initiative → Epic →
 * Task → Sub-task) for the descendant-crawl tests. Returns the created keys top-down.
 */
export async function seedChain(plugin: PMPlugin, parentKey: string, names: string[]): Promise<string[]> {
  const keys: string[] = []
  await mutateMock(plugin, (store) => {
    let parent = parentKey
    for (const name of names) {
      const issue = store.createIssue({
        project: { key: 'DEMO' },
        issuetype: { name: 'Task' },
        summary: name,
        parent: { key: parent }
      })
      keys.push(issue.key)
      parent = issue.key
    }
  })
  return keys
}

/** Read the persisted mock DB for assertions. */
export function readMock(plugin: PMPlugin): Promise<JiraMockStore> {
  return loadMock(plugin, 'DEMO')
}

/**
 * Pin the sync watermark to the past so the next pull re-examines every issue.
 * JIRA bumps `updated` on real changes; in a fast test those can land in the same
 * millisecond as the just-set watermark, so this avoids timing flakiness.
 */
export function rewind(cfg: JiraProjectConfig): void {
  cfg.lastSeenUpdated = '2000-01-01T00:00:00.000+0000'
}

/** A JIRA status object the mock stores on an issue (for inbound-change simulation). */
export function statusObj(name: string, category = 'To Do'): Record<string, unknown> {
  return { name, statusCategory: { name: category } }
}

/** Fetch a mock issue, throwing if absent (keeps tests free of optional chaining). */
export function mustIssue(store: JiraMockStore, key: string): MockIssueRecord {
  const issue = store.getIssue(key)
  if (!issue) throw new Error(`mock issue ${key} missing`)
  return issue
}

/** Assert a value is present and return it narrowed (no non-null assertions in tests). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`${what} missing`)
  return value
}
