import type { Project, FilterState, StatusConfig, PriorityConfig, ViewMode } from '../../../types'
import { PrimaryRow } from './PrimaryRow'
import { FilterRow } from './FilterRow'

/**
 * Header UI state that must survive header rebuilds (view switches). Owned by the
 * ProjectView and passed by reference so the filter bar and the assignee avatar zone
 * re-open in the same state after switching between table/gantt/board.
 */
export interface HeaderUiState {
  filterOpen: boolean
  assigneeZoneOpen: boolean
}

export interface ProjectHeaderProps {
  project: Project
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  /**
   * Avatar initials for the whole project. Passed in rather than derived here: the filter
   * row only knows the people who have tasks, so resolving initials from that alone gave
   * it different initials from every other view of the same project.
   */
  roster: Map<string, string>
  filter: FilterState
  activeSavedViewId: string | null
  /** Persisted, by-reference UI state (filter bar / assignee zone open flags). */
  uiState: HeaderUiState
  onFilterChange: () => void
  onClearFilter: () => void
  onSavedViewSelect: (id: string | null) => void
  onSavedViewSave: (name: string) => Promise<void>
  onSavedViewUpdate: (id: string) => Promise<void>
  onSavedViewDelete: (id: string) => Promise<void>
  /** Current view — the conflict indicator only shows for the Gantt. */
  viewMode: ViewMode
  onToggleConflicts: () => void
  /** Gantt only: whether its controls bar is shown, and the toggle for it. */
  ganttControlsVisible: boolean
  onToggleGanttControls: () => void
}

export class ProjectHeader {
  el: HTMLElement
  private primaryRow: PrimaryRow | null = null
  private filterRow: FilterRow | null = null

  constructor(
    parentEl: HTMLElement,
    private props: ProjectHeaderProps
  ) {
    this.el = parentEl.createDiv('pm-project-header')
    this.render()
  }

  /** Re-render after a filter or activeSavedViewId replacement (e.g., apply saved view, clear). */
  /**
   * Re-render. Pass the current `activeSavedViewId` so the saved-view pills reflect it —
   * the value in props is a snapshot from construction and would otherwise be stale (which
   * left "All" highlighted after selecting a view).
   */
  refresh(activeSavedViewId?: string | null): void {
    if (activeSavedViewId !== undefined) this.props.activeSavedViewId = activeSavedViewId
    this.render()
  }

  /** In-place sync after the user mutated filter via the header (no full re-render). */
  notifyMutation(): void {
    this.primaryRow?.refreshVolatile()
    this.syncFilterRowVisibility()
    this.filterRow?.refreshClearButton()
  }

  setActiveSavedViewId(id: string | null): void {
    this.props.activeSavedViewId = id
    this.primaryRow?.setActiveSavedViewId(id)
  }

  /** Focus the task search box. */
  focusSearch(): void {
    this.primaryRow?.focusSearch()
  }

  /** Update the resource-conflict indicator (Gantt only). */
  setConflicts(count: number, active: boolean): void {
    this.primaryRow?.setConflicts(count, active)
  }

  private render(): void {
    this.el.empty()
    this.primaryRow = new PrimaryRow(this.el, {
      project: this.props.project,
      filter: this.props.filter,
      activeSavedViewId: this.props.activeSavedViewId,
      filterRowExpanded: this.props.uiState.filterOpen,
      onSearchChange: this.props.onFilterChange,
      onSavedViewSelect: this.props.onSavedViewSelect,
      onSavedViewSave: this.props.onSavedViewSave,
      onSavedViewUpdate: this.props.onSavedViewUpdate,
      onSavedViewDelete: this.props.onSavedViewDelete,
      viewMode: this.props.viewMode,
      onToggleConflicts: this.props.onToggleConflicts,
      ganttControlsVisible: this.props.ganttControlsVisible,
      onToggleGanttControls: () => {
        this.props.ganttControlsVisible = !this.props.ganttControlsVisible
        // Push the new value in, like the filter toggle: refreshVolatile() alone would
        // re-render from the value captured at construction and keep the stale highlight.
        this.primaryRow?.setGanttControlsVisible(this.props.ganttControlsVisible)
        this.props.onToggleGanttControls()
      },
      onToggleFilterRow: () => {
        this.props.uiState.filterOpen = !this.props.uiState.filterOpen
        this.syncFilterRowVisibility()
        // Push the new state into PrimaryRow's props — refreshVolatile() alone would
        // re-render with the (stale) value captured at construction, leaving the button
        // highlighted after the bar is collapsed.
        this.primaryRow?.setFilterRowExpanded(this.props.uiState.filterOpen)
      }
    })

    if (this.shouldShowFilterRow()) {
      this.mountFilterRow()
    }
  }

  private syncFilterRowVisibility(): void {
    const shouldShow = this.shouldShowFilterRow()
    if (shouldShow && !this.filterRow) {
      this.mountFilterRow()
    } else if (!shouldShow && this.filterRow) {
      this.filterRow.el.remove()
      this.filterRow = null
    }
  }

  private mountFilterRow(): void {
    this.filterRow = new FilterRow(this.el, {
      project: this.props.project,
      statuses: this.props.statuses,
      priorities: this.props.priorities,
      roster: this.props.roster,
      filter: this.props.filter,
      uiState: this.props.uiState,
      onFilterChange: this.props.onFilterChange,
      onClear: () => {
        // Clearing empties the filters but must NOT collapse the bar — keep it expanded
        // so it stays open until the user explicitly toggles it off.
        this.props.uiState.filterOpen = true
        this.props.onClearFilter()
      }
    })
  }

  private shouldShowFilterRow(): boolean {
    // Visibility is purely the explicit toggle — never coupled to whether filters are
    // active. (Active filters stay discoverable via the count on the Filter button.)
    return this.props.uiState.filterOpen
  }
}
