import { MarkdownView, Plugin, Notice } from 'obsidian'
import { DEFAULT_SETTINGS, PMSettings, Project, ViewMode } from './types'
import { flattenTasks, findTask } from './store/TaskTreeOps'
import { ProjectStore } from './store'
import { PMSettingTab } from './settings'
import { ProjectView, PM_PROJECT_VIEW_TYPE } from './views/ProjectView'
import { DashboardView, PM_DASHBOARD_VIEW_TYPE } from './views/DashboardView'
import { UberProjectView, PM_UBER_VIEW_TYPE } from './views/UberProjectView'
import { PMViewRouter } from './views/PMViewRouter'
import { openProjectModal, openTaskModal, openProjectPicker, openTaskPicker, openImportModal } from './ui/ModalFactory'
import { Notifier } from './components/Notifier'
import { migrateProjects } from './migration'
import { ConnectorRegistry } from './connectors/registry'
import { CONNECTORS } from './connectors'
import { safeAsync } from './utils'

export default class PMPlugin extends Plugin {
  settings: PMSettings = { ...DEFAULT_SETTINGS }
  store!: ProjectStore
  notifier!: Notifier
  router!: PMViewRouter
  undoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []
  redoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []
  /** Registered integration connectors (JIRA, …). */
  connectors = new ConnectorRegistry()

  pushUndo(entry: { undo: () => Promise<void>; redo: () => Promise<void> }): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > 20) this.undoStack.shift()
    this.redoStack = []
  }

  async undoLastAction(): Promise<void> {
    const entry = this.undoStack.pop()
    if (entry) {
      await entry.undo()
      this.redoStack.push(entry)
    }
  }

  async redoLastAction(): Promise<void> {
    const entry = this.redoStack.pop()
    if (entry) {
      await entry.redo()
      this.undoStack.push(entry)
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings()
    this.store = new ProjectStore(this.app, () => this.settings.statuses)
    this.store.registerCacheInvalidation(this)
    // Register connector descriptors (cheap); each connector is built lazily on
    // first real use. Wire the generic store hooks at the registry dispatch.
    this.connectors.init(this)
    for (const d of CONNECTORS) this.connectors.register(d)
    this.store.onTaskChanged = (project, task) => this.connectors.taskChanged(project, task)
    this.store.onTaskDeleted = (project, task) => this.connectors.taskDeleted(project, task)
    this.store.onProjectLoaded = (project) => void this.connectors.projectLoaded(project)
    this.store.onProjectSaved = (project) => void this.connectors.projectSaved(project)
    this.store.onAssigneeRenamed = (project, from, to) => this.connectors.assigneeRenamed(project, from, to)
    this.store.isConnectorKey = (key) => this.connectors.ownsKey(key)
    this.notifier = new Notifier(this)
    this.router = new PMViewRouter(this)

    this.registerView(PM_PROJECT_VIEW_TYPE, (leaf) => new ProjectView(leaf, this))
    this.registerView(PM_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this))
    this.registerView(PM_UBER_VIEW_TYPE, (leaf) => new UberProjectView(leaf, this))

    this.app.workspace.onLayoutReady(
      safeAsync(async () => {
        await migrateProjects(this)
        await this.cleanupStaleProjectFilters()
      })
    )

    this.addRibbonIcon('chart-gantt', 'Project manager', async () => {
      await this.router.openDashboard()
    })

    // Periodic connector sync: tick each minute, let each connector decide which
    // of its enabled projects are due (interval lives in project.ext.<id>).
    this.registerInterval(window.setInterval(() => void this.connectorTick(), 60_000))

    this.addCommand({
      id: 'open-projects',
      name: 'Open projects pane',
      callback: () => {
        void this.router.openDashboard()
      }
    })

    this.addCommand({
      id: 'open-all-projects',
      name: 'Open the all-projects timeline',
      callback: () => {
        void this.router.openUberProject()
      }
    })

    this.addCommand({
      id: 'new-project',
      name: 'Create new project',
      callback: () => {
        openProjectModal(this, {
          onSave: async (project) => {
            await this.router.openProjectByPath(project.filePath)
          }
        })
      }
    })

    this.addCommand({
      id: 'new-task',
      name: 'Create new task',
      callback: () => {
        void this.pickProjectThenCreateTask(null)
      }
    })

    this.addCommand({
      id: 'new-subtask',
      name: 'Create new subtask',
      callback: () => {
        void this.pickProjectThenCreateTask('pick-parent')
      }
    })

    this.addCommand({
      id: 'undo-last-action',
      name: 'Undo last action',
      callback: () => {
        void this.undoLastAction()
      }
    })

    this.addCommand({
      id: 'redo-last-action',
      name: 'Redo last action',
      callback: () => {
        void this.redoLastAction()
      }
    })

    this.addCommand({
      id: 'sync-connectors',
      name: 'Sync this project with its connectors',
      // Two bindings: Mod+Shift+S is the obvious one but it's contended — a command that
      // registered first keeps it, and Linux desktops often grab it for screenshots.
      // Alt+Shift+S sits with the plugin's other Alt bindings and is free.
      // eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- deliberate: only active when a project view with a syncable connector is focused
      hotkeys: [
        { modifiers: ['Mod', 'Shift'], key: 's' },
        { modifiers: ['Alt', 'Shift'], key: 's' }
      ],
      checkCallback: (checking: boolean) => {
        const project = this.app.workspace.getActiveViewOfType(ProjectView)?.project
        if (!project || !this.connectors.syncable(project).length) return false
        if (!checking) void this.connectors.syncNow(project)
        return true
      }
    })

    this.addCommand({
      id: 'import-notes-as-tasks',
      name: 'Import notes as tasks',
      callback: () => {
        void this.importNotes()
      }
    })

    // Switch the active project view between its sub-views (only when a project
    // view is focused). Defaults to Alt+A/S/D; users can rebind in Hotkeys.
    const viewHotkeys: { id: string; name: string; key: string; mode: ViewMode }[] = [
      { id: 'view-table', name: 'Switch to Table view', key: 'a', mode: 'table' },
      { id: 'view-gantt', name: 'Switch to Gantt view', key: 's', mode: 'gantt' },
      { id: 'view-kanban', name: 'Switch to Board view', key: 'd', mode: 'kanban' }
    ]
    for (const v of viewHotkeys) {
      this.addCommand({
        id: v.id,
        name: v.name,
        // eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- deliberate: Alt+A/S/D quick view switch, only active when a project view is focused
        hotkeys: [{ modifiers: ['Alt'], key: v.key }],
        checkCallback: (checking: boolean) => {
          const view = this.app.workspace.getActiveViewOfType(ProjectView)
          if (!view) return false
          if (!checking) view.setView(v.mode)
          return true
        }
      })
    }

    this.addCommand({
      id: 'toggle-maximize-view',
      name: 'Toggle maximized view',
      // eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- deliberate: Alt+Z hides the chrome, only active when a project view is focused
      hotkeys: [{ modifiers: ['Alt'], key: 'z' }],
      checkCallback: (checking: boolean) => {
        // Either view: both hide the same chrome, and the cross-project timeline is
        // exactly where the extra vertical space is worth most.
        const view =
          this.app.workspace.getActiveViewOfType(ProjectView) ?? this.app.workspace.getActiveViewOfType(UberProjectView)
        if (!view) return false
        if (!checking) view.toggleMaximize()
        return true
      }
    })

    this.addCommand({
      id: 'focus-search',
      name: 'Focus task search',
      // eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- deliberate: Alt+F focuses search, only active when a project view is focused
      hotkeys: [{ modifiers: ['Alt'], key: 'f' }],
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ProjectView)
        if (!view) return false
        if (!checking) view.focusSearch()
        return true
      }
    })

    this.addCommand({
      id: 'open-current-as-project',
      name: 'Open current file as project',
      checkCallback: (checking: boolean) => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView)
        const file = md?.file
        if (!file) return false
        const cache = this.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.['pm-project'] !== true) return false
        if (checking) return true
        void md.leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
        return true
      }
    })

    this.addSettingTab(new PMSettingTab(this.app, this))
    this.notifier.start()
  }

  onunload(): void {
    this.notifier.stop()
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PMSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {})
    if (!saved?.statuses?.length) this.settings.statuses = DEFAULT_SETTINGS.statuses
    if (!saved?.priorities?.length) this.settings.priorities = DEFAULT_SETTINGS.priorities
    if (!this.settings.projectFilters) this.settings.projectFilters = {}
    if (!this.settings.collapsedTasks) this.settings.collapsedTasks = {}

    let migrated = false
    // Upgrade the default status icons to the clearer pictograph set — but only for
    // statuses that still carry the exact old default icon, so any custom icon is kept.
    const ICON_UPGRADE: Record<string, { from: string; to: string }> = {
      'in-progress': { from: '♻️', to: '🚧' },
      blocked: { from: '🛑', to: '⛔' },
      review: { from: '✏️', to: '👀' },
      done: { from: '🟢', to: '✅' },
      cancelled: { from: '⚫', to: '❌' }
    }
    for (const s of this.settings.statuses) {
      if (s.complete === undefined) {
        s.complete = s.id === 'done' || s.id === 'cancelled'
        migrated = true
      }
      const up = ICON_UPGRADE[s.id]
      if (up && s.icon === up.from) {
        s.icon = up.to
        migrated = true
      }
    }

    // ganttHideDone was a global gantt toggle; replaced by per-project filter.statuses
    // excluding terminal statuses. Seed projects whose filter has no status selection yet.
    const legacy = (saved ?? {}) as { ganttHideDone?: boolean }
    if (legacy.ganttHideDone === true) {
      const nonTerminal = this.settings.statuses.filter((s) => !s.complete).map((s) => s.id)
      for (const entry of Object.values(this.settings.projectFilters)) {
        if (entry.filter.statuses.length === 0) {
          entry.filter.statuses = [...nonTerminal] // a fresh array per entry — never a shared ref
        }
      }
      migrated = true
    }

    if (migrated) await this.saveSettings()
  }

  async cleanupStaleProjectFilters(): Promise<void> {
    const filters = this.settings.projectFilters
    const cleaned: typeof filters = {}
    let dirty = false
    for (const [path, entry] of Object.entries(filters)) {
      if (this.app.vault.getAbstractFileByPath(path)) {
        cleaned[path] = entry
      } else {
        dirty = true
      }
    }
    const cleanedCollapsed: typeof this.settings.collapsedTasks = {}
    for (const [path, ids] of Object.entries(this.settings.collapsedTasks)) {
      if (this.app.vault.getAbstractFileByPath(path)) {
        cleanedCollapsed[path] = ids
      } else {
        dirty = true
      }
    }
    if (dirty) {
      this.settings.projectFilters = cleaned
      this.settings.collapsedTasks = cleanedCollapsed
      await this.saveSettings()
    }
  }

  /**
   * Overlay the persisted collapsed-task state onto a freshly loaded project.
   * Projects with no record yet keep whatever legacy frontmatter said.
   */
  applyCollapsedState(project: Project): void {
    const ids = this.settings.collapsedTasks[project.filePath]
    if (!ids) return
    const set = new Set(ids)
    for (const { task } of flattenTasks(project.tasks)) {
      task.collapsed = set.has(task.id)
    }
  }

  /** Persist the project's current collapsed flags. Call after toggling task.collapsed. */
  async persistCollapsedState(project: Project): Promise<void> {
    this.settings.collapsedTasks[project.filePath] = flattenTasks(project.tasks)
      .filter((f) => f.task.collapsed)
      .map((f) => f.task.id)
    await this.saveSettings()
  }

  /**
   * Flip a task's collapsed flag and persist. Resolves the task by id against
   * the live tree so it works even when a view renders filtered clones.
   */
  async toggleTaskCollapsed(project: Project, taskId: string): Promise<void> {
    const task = findTask(project.tasks, taskId)
    if (!task) return
    task.collapsed = !task.collapsed
    await this.persistCollapsedState(project)
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  showNotice(msg: string, duration = 3000): void {
    new Notice(msg, duration)
  }

  /** Re-render every open project view, e.g. after a settings change affects rendering. */
  refreshProjectViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)) {
      if (leaf.view instanceof ProjectView) void leaf.view.refreshProject()
    }
  }

  /**
   * Periodic tick: give each connector a chance to sync its enabled projects.
   * The connector's syncTick decides whether the project is actually due.
   */
  private async connectorTick(): Promise<void> {
    if (!this.connectors.size) return
    // Don't poll while Obsidian is hidden/minimized — resume on the next tick once visible.
    if (activeDocument.hidden) return
    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    let changed = false
    for (const p of projects) {
      // activeFor only builds connectors the project actually carries data for.
      for (const c of this.connectors.activeFor(p)) {
        if (typeof c.syncTick !== 'function' || !c.isEnabled(p)) continue
        try {
          const r = await c.syncTick(p)
          if (r.changed) changed = true
        } catch (e) {
          console.error(`[PM] connector "${c.id}" sync failed for`, p.filePath, e)
        }
      }
    }
    if (changed) this.refreshProjectViews()
  }

  /** Show project picker, then open TaskModal to create a task (optionally pick parent for subtask) */
  private async pickProjectThenCreateTask(mode: null | 'pick-parent'): Promise<void> {
    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }
    openProjectPicker(this, projects, (project) => {
      if (mode === 'pick-parent') {
        const flat = flattenTasks(project.tasks)
        if (!flat.length) {
          this.showNotice('No tasks in this project. Create a task first.')
          return
        }
        openTaskPicker(
          this,
          flat.map((f) => f.task),
          (parentTask) => {
            this.openTaskModalForProject(project, parentTask.id)
          }
        )
      } else {
        this.openTaskModalForProject(project, null)
      }
    })
  }

  private openTaskModalForProject(project: Project, parentId: string | null): void {
    openTaskModal(this, project, {
      parentId,
      onSave: async () => {
        await this.store.saveProject(project)
        await this.router.openProjectByPath(project.filePath)
      }
    })
  }

  private async importNotes(): Promise<void> {
    const activeLeaves = this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)
    let activeProject: Project | null = null

    for (const leaf of activeLeaves) {
      if (!(leaf.view instanceof ProjectView)) continue
      if (leaf.view.project) {
        activeProject = leaf.view.project
        break
      }
    }

    if (activeProject) {
      const project = activeProject
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, activeProject, onImportComplete)
      return
    }

    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }

    openProjectPicker(this, projects, (project) => {
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, project, onImportComplete)
    })
  }
}
