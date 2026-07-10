import { Menu } from 'obsidian'
import type PMPlugin from '../main'
import { Project, Task, TaskType } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { wouldCreateCycle } from '../store/Scheduler'
import { renderPropRow, renderProgressSlider, renderChipList } from '../ui/FormField'
import { Chip } from '../ui/primitives/Chip'
import { SegmentedControl } from '../ui/primitives/SegmentedControl'
import { getStatusConfig, getPriorityConfig, formatBadgeText, isTerminalStatus } from '../utils'
import { TextSuggest } from '../ui/primitives/TextSuggest'
import { renderCustomFieldInput } from './CustomFieldInputs'
import { TaskPickerModal, TagPickerModal } from './PickerModals'

export interface TaskFormFieldsContext {
  task: Task
  project: Project
  plugin: PMPlugin
  parentId: string | null
  setParentId: (id: string | null) => void
  rerender: () => void
}

/**
 * Renders all property rows (status, priority, type, dates, assignees, tags, deps, custom fields)
 * into the given container.
 */
export function renderTaskFormFields(container: HTMLElement, ctx: TaskFormFieldsContext): void {
  const { task, project, plugin, rerender } = ctx

  // Status
  renderPropRow(container, 'Status', () => {
    const statusConfig = getStatusConfig(plugin.settings.statuses, task.status)
    const wrap = createDiv('pm-prop-value')
    new Chip(wrap)
      .setLabel(formatBadgeText(statusConfig?.icon, statusConfig?.label ?? task.status))
      .setColor(statusConfig?.color ?? 'var(--text-muted)')
      .setVariant('solid')
      .setDot(!statusConfig?.icon)
      .onClick((e) => {
        const menu = new Menu()
        for (const s of plugin.settings.statuses) {
          menu.addItem((item) =>
            item
              .setTitle(formatBadgeText(s.icon, s.label))
              .setChecked(s.id === task.status)
              .onClick(() => {
                task.status = s.id
                rerender()
              })
          )
        }
        menu.showAtMouseEvent(e)
      })
    return wrap
  })

  // Priority
  renderPropRow(container, 'Priority', () => {
    const prioConfig = getPriorityConfig(plugin.settings.priorities, task.priority)
    const wrap = createDiv('pm-prop-value')
    new Chip(wrap)
      .setLabel(formatBadgeText(prioConfig?.icon, prioConfig?.label ?? task.priority))
      .setColor(prioConfig?.color ?? 'var(--text-muted)')
      .setVariant('plain')
      .setDot(!prioConfig?.icon)
      .onClick((e) => {
        const menu = new Menu()
        for (const p of plugin.settings.priorities) {
          menu.addItem((item) =>
            item
              .setTitle(formatBadgeText(p.icon, p.label))
              .setChecked(p.id === task.priority)
              .onClick(() => {
                task.priority = p.id
                rerender()
              })
          )
        }
        menu.showAtMouseEvent(e)
      })
    return wrap
  })

  // Type
  renderPropRow(container, 'Type', () => {
    const wrap = createDiv('pm-prop-value')
    new SegmentedControl<TaskType>(wrap, {
      options: [
        { id: 'task', label: 'Task' },
        { id: 'subtask', label: 'Subtask', cls: 'pm-segmented-btn--subtask' },
        { id: 'milestone', label: 'Milestone', cls: 'pm-segmented-btn--milestone' }
      ],
      active: task.type,
      onChange: (type) => {
        task.type = type
        if (type === 'milestone') {
          task.start = ''
          task.progress = 0
        }
        if (type !== 'subtask') {
          ctx.setParentId(null)
        }
        rerender()
      }
    })
    return wrap
  })

  // Parent task selector (subtask type only)
  if (task.type === 'subtask') {
    renderPropRow(container, 'Parent task', () => {
      const wrap = createDiv('pm-prop-value')
      const allTasks = flattenTasks(project.tasks)
        .map((f) => f.task)
        .filter((t) => t.id !== task.id)
      const sel = wrap.createEl('select', { cls: 'pm-prop-select' })
      sel.createEl('option', { value: '', text: ctx.parentId ? '' : '— Select parent —' })
      for (const t of allTasks) {
        const opt = sel.createEl('option', { value: t.id, text: t.title })
        if (t.id === ctx.parentId) opt.selected = true
      }
      sel.addEventListener('change', () => {
        ctx.setParentId(sel.value || null)
      })
      return wrap
    })
  }

  // Progress (hidden for milestones)
  if (task.type !== 'milestone') {
    renderPropRow(container, 'Progress', () => {
      const wrap = createDiv()
      return renderProgressSlider(wrap, task.progress, (v) => {
        task.progress = v
      })
    })
  }

  // Start date (hidden for milestones)
  if (task.type !== 'milestone') {
    renderPropRow(container, 'Start', () => {
      const input = createEl('input', { type: 'date', cls: 'pm-prop-value pm-prop-date' })
      input.value = task.start
      input.addEventListener('change', () => {
        task.start = input.value
      })
      return input
    })
  }

  // Due date
  renderPropRow(container, task.type === 'milestone' ? 'Date' : 'Due', () => {
    const input = createEl('input', { type: 'date', cls: 'pm-prop-value pm-prop-date' })
    input.value = task.due
    input.addEventListener('change', () => {
      task.due = input.value
    })
    return input
  })

  // Connector-contributed task fields (e.g. JIRA sync toggle), gated per connector.
  // activeFor avoids building connectors the project doesn't use.
  for (const c of plugin.connectors.activeFor(project)) {
    if (c.renderTaskField && c.isEnabled(project)) c.renderTaskField(container, task, project)
  }

  // Completed date — auto-stamped when the task enters a complete status, but editable.
  // Shown once the task is in a complete status or already carries a date.
  if (task.completed || isTerminalStatus(task.status, plugin.settings.statuses)) {
    renderPropRow(container, 'Completed', () => {
      const input = createEl('input', { type: 'date', cls: 'pm-prop-value pm-prop-date' })
      input.value = task.completed
      input.addEventListener('change', () => {
        task.completed = input.value
      })
      return input
    })
  }

  // Assignees
  renderPropRow(container, 'Assignees', () => {
    const wrap = createDiv('pm-prop-value pm-prop-assignees')
    // Kept across re-renders so adding someone can hand focus straight back for the next.
    let suggestEl: HTMLInputElement | null = null
    const render = (focusSuggest = false) => {
      const all = [...new Set([...project.teamMembers, ...plugin.settings.globalTeamMembers])]
      const remaining = all.filter((m) => !task.assignees.includes(m))
      renderChipList(wrap, task.assignees, {
        variant: 'accent',
        shape: 'pill',
        onRemove: (a) => {
          task.assignees = task.assignees.filter((x) => x !== a)
          render()
        },
        renderAdd: (el) => {
          // Type-ahead beside the menu: quicker than hunting a long team list, and it
          // still accepts a name nobody has been assigned before.
          const suggest = el.createEl('input', {
            type: 'text',
            cls: 'pm-assignee-suggest',
            placeholder: 'Add assignee\u2026'
          })
          suggestEl = suggest
          const commit = (name: string) => {
            const value = name.trim()
            if (value && !task.assignees.includes(value)) task.assignees.push(value)
            render(true)
          }
          new TextSuggest(plugin.app, suggest, () => remaining, commit)
          suggest.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault()
              commit(suggest.value)
            }
          })

          const addBtn = el.createEl('button', { text: '+ add', cls: 'pm-prop-add-btn' })
          const showNameInput = () => {
            addBtn.addClass('pm-hidden')
            const input = el.createEl('input', { type: 'text', cls: 'pm-tag-input', placeholder: 'Name\u2026' })
            input.focus()
            const commit = () => {
              const name = input.value.trim()
              if (name && !task.assignees.includes(name)) task.assignees.push(name)
              render()
            }
            input.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') commit()
              if (ev.key === 'Escape') render()
            })
            input.addEventListener('blur', commit)
          }
          addBtn.addEventListener('click', (ev) => {
            if (remaining.length) {
              const menu = new Menu()
              for (const m of remaining) {
                menu.addItem((item) =>
                  item.setTitle(m).onClick(() => {
                    task.assignees.push(m)
                    render()
                  })
                )
              }
              menu.addSeparator()
              menu.addItem((item) => item.setTitle('Type a name\u2026').onClick(() => showNameInput()))
              menu.showAtMouseEvent(ev)
            } else {
              showNameInput()
            }
          })
        }
      })
      if (focusSuggest) suggestEl?.focus()
    }
    render()
    return wrap
  })

  // Tags
  renderPropRow(container, 'Tags', () => {
    const wrap = createDiv('pm-prop-value pm-prop-tags')
    const render = () => {
      const allProjectTags = [...new Set(flattenTasks(project.tasks).flatMap((f) => f.task.tags))].filter(
        (t) => !task.tags.includes(t)
      )
      renderChipList(wrap, task.tags, {
        shape: 'pill',
        onRemove: (tag) => {
          task.tags = task.tags.filter((x) => x !== tag)
          render()
        },
        onAdd: () => {
          new TagPickerModal(plugin.app, allProjectTags, (tag) => {
            if (!task.tags.includes(tag)) {
              task.tags.push(tag)
              render()
            }
          }).open()
        },
        addLabel: '+ tag'
      })
    }
    render()
    return wrap
  })

  // Dependencies
  renderPropRow(container, 'Depends on', () => {
    const wrap = createDiv('pm-prop-value pm-prop-deps')
    const allTasks = flattenTasks(project.tasks)
      .map((f) => f.task)
      .filter((t) => t.id !== task.id)
    const render = () => {
      renderChipList(
        wrap,
        task.dependencies.filter((id) => allTasks.some((t) => t.id === id)),
        {
          shape: 'rounded',
          labelFn: (depId) => allTasks.find((t) => t.id === depId)?.title ?? depId,
          onRemove: (depId) => {
            task.dependencies = task.dependencies.filter((x) => x !== depId)
            render()
          },
          onAdd: () => {
            const available = allTasks.filter(
              (t) => !task.dependencies.includes(t.id) && !wouldCreateCycle(project.tasks, task.id, t.id)
            )
            new TaskPickerModal(
              plugin.app,
              available,
              (t) => {
                task.dependencies.push(t.id)
                render()
              },
              'Search tasks to add as dependency…'
            ).open()
          },
          addLabel: '+ Add dependency'
        }
      )
    }
    render()
    return wrap
  })

  // Custom fields
  if (project.customFields.length > 0) {
    const cfSection = container.createDiv('pm-modal-section')
    cfSection.createEl('h4', { text: 'Custom fields', cls: 'pm-modal-section-title' })
    const cfProps = cfSection.createDiv('pm-modal-props')
    for (const cf of project.customFields) {
      renderPropRow(cfProps, cf.name, () => renderCustomFieldInput(cf, task, project, plugin))
    }
  }
}
