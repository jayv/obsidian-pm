import type PMPlugin from '../main'
import type { Project, Task } from '../types'

/**
 * A pluggable integration (e.g. JIRA). The core calls these hooks at generic
 * points — persistence (via the task/project `ext` bags), lifecycle/sync events,
 * and UI section contributions — so connector-specific code stays out of core.
 * All members except id/name/isEnabled are optional.
 */
export interface Connector {
  readonly id: string
  readonly name: string

  /** Register commands / one-time setup. Called once when the connector is first built. */
  onload?(plugin: PMPlugin): void

  /** Whether this connector is active for a given project. */
  isEnabled(project: Project): boolean

  /** A task was mutated (fires before save) — e.g. to coalesce a sync queue. */
  onTaskChanged?(project: Project, task: Task): void
  /**
   * A task was deleted in Obsidian (fires before save, once per removed task incl.
   * descendants) — e.g. to stop re-offering its remote counterpart for import.
   */
  onTaskDeleted?(project: Project, task: Task): void
  /** A project finished loading. */
  onProjectLoaded?(project: Project): void | Promise<void>
  /** A project finished saving. */
  onProjectSaved?(project: Project): void | Promise<void>
  /** Periodic sync opportunity; resolves whether local data changed (→ refresh views). */
  syncTick?(project: Project): Promise<{ changed: boolean }>
  /** Run a sync now on user request (e.g. a toolbar button). Refreshes views itself. */
  syncNow?(project: Project): Promise<void>

  /** Contribute a section to the main settings tab. */
  renderGlobalSettings?(containerEl: HTMLElement): void
  /**
   * Contribute a section to the project settings modal. `onClose` dismisses the
   * modal; `onChange` asks the host to re-render the whole modal (e.g. after the
   * connector mutates shared project fields like team members).
   */
  renderProjectPanel?(containerEl: HTMLElement, project: Project, onClose: () => void, onChange?: () => void): void
  /** Contribute a row to the task form. */
  renderTaskField?(containerEl: HTMLElement, task: Task, project: Project): void
  /** Contribute project-toolbar actions. */
  toolbarActions?(project: Project): { label: string; onClick: () => void }[]
  /** A short label for a task (e.g. the issue key) shown as a pill in the table. */
  taskBadge?(task: Task): string | null
}

/**
 * Static metadata + a lazy factory for a connector. The registry can answer
 * persistence questions (`ownsKey`) and decide relevance from the descriptor
 * alone, building the actual `Connector` only when it's first needed.
 */
export interface ConnectorDescriptor {
  readonly id: string
  readonly name: string
  /**
   * Frontmatter keys this connector owns. The core round-trips these opaquely
   * (kept flat in the note) into/out of the task/project `ext` bag, so the
   * connector — not core — defines its persisted fields. e.g. JIRA owns the
   * `jira` key (a nested object holding its task/project data).
   */
  readonly frontmatterKeys?: { keys?: string[]; prefixes?: string[] }
  /** Build the connector instance. Called at most once, lazily, by the registry. */
  create(plugin: PMPlugin): Connector
}

/**
 * Holds connector descriptors and fans core events out to them, instantiating
 * each connector lazily on first real use. The frequent, non-interactive paths
 * (`ownsKey`, store events, sync tick) avoid building a connector unless a
 * project actually carries its data, so an unused connector is never constructed.
 */
export class ConnectorRegistry {
  private readonly descriptors: ConnectorDescriptor[] = []
  private readonly instances = new Map<string, Connector>()
  private plugin: PMPlugin | null = null

  /** Provide the plugin used to build connectors lazily. Call once on plugin load. */
  init(plugin: PMPlugin): void {
    this.plugin = plugin
  }

  register(descriptor: ConnectorDescriptor): void {
    this.descriptors.push(descriptor)
  }

  /** Number of registered connectors — lets callers skip work when there are none. */
  get size(): number {
    return this.descriptors.length
  }

  /** True if any connector owns this frontmatter key. Never instantiates. */
  ownsKey(key: string): boolean {
    for (const d of this.descriptors) {
      const fm = d.frontmatterKeys
      if (fm?.keys?.includes(key)) return true
      if (fm?.prefixes?.some((p) => key.startsWith(p))) return true
    }
    return false
  }

  /**
   * Every connector, instantiated. For explicit UI surfaces (settings tab,
   * project modal) where the user is deliberately configuring connectors.
   */
  all(): Connector[] {
    return this.descriptors.map((d) => this.instance(d))
  }

  /**
   * Connectors that already carry data on this project (their id is present in
   * `project.ext`), instantiated. Used by the frequent, non-interactive paths so
   * a project that has never touched a connector never builds it.
   */
  activeFor(project: Project): Connector[] {
    const ext = project.ext
    if (!ext) return []
    const out: Connector[] = []
    for (const d of this.descriptors) {
      if (d.id in ext) out.push(this.instance(d))
    }
    return out
  }

  /** Short labels (e.g. the Jira key) contributed by the project's active connectors. */
  taskBadges(project: Project, task: Task): string[] {
    return this.activeFor(project).flatMap((c) => {
      const badge = c.taskBadge?.(task)
      return badge ? [badge] : []
    })
  }

  taskChanged(project: Project, task: Task): void {
    for (const c of this.activeFor(project)) c.onTaskChanged?.(project, task)
  }

  taskDeleted(project: Project, task: Task): void {
    for (const c of this.activeFor(project)) c.onTaskDeleted?.(project, task)
  }

  async projectLoaded(project: Project): Promise<void> {
    for (const c of this.activeFor(project)) await c.onProjectLoaded?.(project)
  }

  async projectSaved(project: Project): Promise<void> {
    for (const c of this.activeFor(project)) await c.onProjectSaved?.(project)
  }

  /** Build (once), cache, and run onload for a connector. */
  private instance(descriptor: ConnectorDescriptor): Connector {
    let c = this.instances.get(descriptor.id)
    if (!c) {
      if (!this.plugin) throw new Error('ConnectorRegistry.init(plugin) was not called')
      c = descriptor.create(this.plugin)
      this.instances.set(descriptor.id, c)
      c.onload?.(this.plugin)
    }
    return c
  }
}
