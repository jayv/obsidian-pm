import { ButtonComponent, Menu, setTooltip } from 'obsidian'
import type {
  Project,
  FilterState,
  StatusConfig,
  PriorityConfig,
  TaskPriority,
  DueDateFilter,
  WeekOffset
} from '../../../types'
import { collectAllAssignees, collectAllTags } from '../../../store'
import { UNASSIGNED, countActiveFilters } from '../../../store/TaskFilter'
import { renderFilterDropdown } from '../../FilterDropdown'
import { Pill } from '../../primitives/Pill'
import { Avatar, displayName, initialsRoster } from '../../primitives/Avatar'
import { SegmentedToggleGroup } from '../../primitives/SegmentedControl'
import { formatBadgeText } from '../../../utils'
import type { HeaderUiState } from './ProjectHeader'

export interface FilterRowProps {
  project: Project
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  filter: FilterState
  /** Persisted UI state — the assignee zone open flag survives view switches. */
  uiState: HeaderUiState
  onFilterChange: () => void
  onClear: () => void
}

const DUE_LABELS: Record<DueDateFilter, string> = {
  any: 'Due date',
  overdue: 'Overdue',
  'this-week': 'This week',
  'this-month': 'This month',
  'no-date': 'No date'
}

export class FilterRow {
  el: HTMLElement
  private clearBtn: ButtonComponent | null = null
  private assigneeZoneEl: HTMLElement | null = null

  constructor(
    parentEl: HTMLElement,
    private props: FilterRowProps
  ) {
    this.el = parentEl.createDiv('pm-project-header-filter')
    this.render()
  }

  private render(): void {
    this.el.empty()
    this.assigneeZoneEl = null
    const { filter, statuses, priorities, project } = this.props

    const notify = () => {
      this.props.onFilterChange()
      this.updateClearButton()
    }

    renderFilterDropdown(
      this.el,
      'Status',
      filter.statuses,
      statuses.map((s) => ({ id: s.id, label: formatBadgeText(s.icon, s.label) })),
      (selected) => {
        filter.statuses = selected
        notify()
      }
    )

    renderFilterDropdown(
      this.el,
      'Priority',
      filter.priorities,
      priorities.map((p) => ({ id: p.id, label: formatBadgeText(p.icon, p.label) })),
      (selected) => {
        filter.priorities = selected as TaskPriority[]
        notify()
      }
    )

    const allAssignees = collectAllAssignees(project.tasks)
    if (allAssignees.length) this.renderAssigneeFilter(notify, allAssignees)

    const allTags = collectAllTags(project.tasks)
    if (allTags.length) {
      renderFilterDropdown(
        this.el,
        'Tag',
        filter.tags,
        allTags.map((t) => ({ id: t, label: t })),
        (selected) => {
          filter.tags = selected
          notify()
        }
      )
    }

    this.renderDueDatePill(notify)
    this.renderActiveWeekPills(notify)
    this.renderArchivedPill(notify)
    this.renderClearButton()
    // The avatar zone spans the full width, so keep it as the last child — it wraps onto
    // its own row below the pills rather than pushing later pills around.
    if (this.assigneeZoneEl) this.el.appendChild(this.assigneeZoneEl)
  }

  /**
   * Assignee filter as a toggle pill that reveals a zone of colored initial-circles
   * (the same avatars shown on tasks/gantt). Clicking an avatar selects/deselects that
   * assignee; selected ones get a bold accent ring while the rest dim, so the active
   * selection reads clearly even on a projector.
   */
  private renderAssigneeFilter(notify: () => void, names: string[]): void {
    const { filter } = this.props
    // The filter row shows the whole roster, so it's the natural place to resolve initials
    // for it: every other view of this project renders against the same set.
    const roster = initialsRoster(names)
    const pill = new Pill(this.el).setAriaLabel('Filter by assignee')
    const zone = createDiv('pm-assignee-filter')

    const sync = () => {
      const n = filter.assignees.length
      pill.setLabel(n ? `Assignee: ${n}` : 'Assignee').setActive(n > 0)
      pill.el.toggleClass('pm-pill--open', this.props.uiState.assigneeZoneOpen)
      zone.style.display = this.props.uiState.assigneeZoneOpen ? 'flex' : 'none'
    }

    pill.onClick(() => {
      this.props.uiState.assigneeZoneOpen = !this.props.uiState.assigneeZoneOpen
      sync()
    })

    // One chip per assignee, plus a "?" chip for tasks with nobody assigned. Picks are
    // cumulative (OR), so "?" combines with names rather than excluding them — and
    // shift- or double-click switches to just that person in one action.
    const paints: (() => void)[] = []
    const repaint = (): void => {
      for (const p of paints) p()
      sync()
      notify()
    }
    const addChip = (value: string, render: (btn: HTMLElement) => void): void => {
      const btn = zone.createEl('button', { cls: 'pm-assignee-pick' })
      render(btn)
      const paint = (): void => {
        const on = filter.assignees.includes(value)
        btn.toggleClass('is-selected', on)
        btn.setAttribute('aria-pressed', String(on))
      }
      paints.push(paint)
      paint()

      /** Make this the only pick — the fast "show me just this person" switch. */
      const solo = (): void => {
        filter.assignees.length = 0 // mutate in place; the live filter is shared by ref
        filter.assignees.push(value)
        repaint()
      }
      btn.addEventListener('click', (e) => {
        if (e.shiftKey) {
          solo()
          return
        }
        const i = filter.assignees.indexOf(value)
        if (i >= 0) filter.assignees.splice(i, 1)
        else filter.assignees.push(value)
        repaint()
      })
      btn.addEventListener('dblclick', (e) => {
        // The two clicks that precede this cancel out (same chip), so soloing here lands
        // on the right state without needing to debounce the click handler.
        e.preventDefault()
        solo()
      })
    }

    const soloHint = ' — shift- or double-click to show only this'
    for (const name of names) {
      addChip(name, (btn) => {
        new Avatar(btn).setName(name, roster).setSize('sm')
        setTooltip(btn, displayName(name) + soloHint)
      })
    }
    addChip(UNASSIGNED, (btn) => {
      btn.createSpan({ cls: 'pm-avatar pm-avatar--sm pm-avatar--none', text: '?' })
      setTooltip(btn, 'Unassigned' + soloHint)
    })

    sync()
    this.assigneeZoneEl = zone
  }

  private renderDueDatePill(notify: () => void): void {
    const { filter } = this.props
    const pill = new Pill(this.el)
    const updateLabel = () => {
      const current = filter.dueDateFilter
      pill.setLabel(current !== 'any' ? `Due: ${DUE_LABELS[current]}` : DUE_LABELS.any).setActive(current !== 'any')
    }
    updateLabel()
    pill.onClick((e) => {
      const menu = new Menu()
      const opts: DueDateFilter[] = ['any', 'overdue', 'this-week', 'this-month', 'no-date']
      for (const opt of opts) {
        menu.addItem((item) =>
          item
            .setTitle(DUE_LABELS[opt])
            .setChecked(filter.dueDateFilter === opt)
            .onClick(() => {
              filter.dueDateFilter = opt
              updateLabel()
              notify()
            })
        )
      }
      menu.showAtMouseEvent(e)
    })
  }

  /**
   * Active-week window as three cumulative toggles. Each adds its Mon–Sun week to the
   * filter, so e.g. "This week" + "Next week" shows everything active across the
   * two-week span. None selected = no week filter.
   */
  private renderActiveWeekPills(notify: () => void): void {
    const { filter } = this.props
    const wrap = this.el.createDiv('pm-filter-weeks')
    wrap.createSpan({ cls: 'pm-filter-weeks-label', text: 'Week' })
    const group = new SegmentedToggleGroup<WeekOffset>(wrap, {
      options: [
        { id: -1, label: 'Prev', ariaLabel: 'Previous week' },
        { id: 0, label: 'This', ariaLabel: 'This week' },
        { id: 1, label: 'Next', ariaLabel: 'Next week' }
      ],
      selected: filter.activeWeeks,
      onToggle: (offset) => {
        const i = filter.activeWeeks.indexOf(offset)
        // Mutate in place — the live filter object is shared by reference with the view.
        if (i >= 0) filter.activeWeeks.splice(i, 1)
        else filter.activeWeeks.push(offset)
        group.setSelected(filter.activeWeeks)
        notify()
      }
    })
  }

  private renderArchivedPill(notify: () => void): void {
    const { filter } = this.props
    const pill = new Pill(this.el).setLabel('Archived').setActive(filter.showArchived)
    pill.onClick(() => {
      filter.showArchived = !filter.showArchived
      pill.setActive(filter.showArchived)
      notify()
    })
  }

  private renderClearButton(): void {
    const count = countActiveFilters(this.props.filter)
    if (count === 0) {
      this.clearBtn = null
      return
    }
    this.clearBtn = new ButtonComponent(this.el).setButtonText(`Clear (${count})`).onClick(() => {
      this.props.onClear()
    })
  }

  refreshClearButton(): void {
    this.updateClearButton()
  }

  private updateClearButton(): void {
    if (this.clearBtn) {
      this.clearBtn.buttonEl.remove()
      this.clearBtn = null
    }
    this.renderClearButton()
  }
}
