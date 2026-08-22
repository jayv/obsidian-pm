import { TFile } from 'obsidian'
import type PMPlugin from '../main'
import { PM_DASHBOARD_VIEW_TYPE } from './DashboardView'
import { PM_UBER_VIEW_TYPE } from './UberProjectView'
import { PM_PROJECT_VIEW_TYPE } from './ProjectView'

export class PMViewRouter {
  constructor(private plugin: PMPlugin) {}

  async openDashboard(): Promise<void> {
    const ws = this.plugin.app.workspace
    const existing = ws.getLeavesOfType(PM_DASHBOARD_VIEW_TYPE)[0]
    if (existing) {
      await ws.revealLeaf(existing)
      return
    }
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_DASHBOARD_VIEW_TYPE, state: {} })
    await ws.revealLeaf(leaf)
  }

  /** Open the cross-project timeline, or focus the tab already showing it. */
  async openUberProject(): Promise<void> {
    const ws = this.plugin.app.workspace
    const existing = ws.getLeavesOfType(PM_UBER_VIEW_TYPE)[0]
    if (existing) {
      await ws.revealLeaf(existing)
      return
    }
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_UBER_VIEW_TYPE, state: {} })
    await ws.revealLeaf(leaf)
  }

  /**
   * Open a project, or focus the tab already showing it.
   *
   * Never open a second view of the same project: each one holds its own in-memory task
   * tree, and they both write the project file — so the last save wins and silently
   * discards whatever the other copy changed (tasks can end up orphaned from the tree,
   * their files intact but referenced by nothing).
   */
  async openProject(file: TFile): Promise<void> {
    const ws = this.plugin.app.workspace
    const open = ws
      .getLeavesOfType(PM_PROJECT_VIEW_TYPE)
      .find((l) => (l.getViewState().state as { filePath?: string } | undefined)?.filePath === file.path)
    if (open) {
      await ws.revealLeaf(open)
      return
    }
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
    await ws.revealLeaf(leaf)
  }

  async openProjectByPath(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) await this.openProject(file)
  }
}
