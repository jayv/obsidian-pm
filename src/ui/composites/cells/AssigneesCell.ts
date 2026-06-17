import { Menu, setTooltip } from 'obsidian'
import { AvatarStack } from '../../primitives/AvatarStack'
import { displayName } from '../../primitives/Avatar'
import type { Task } from '../../../types'

export interface AssigneesCellProps {
  task: Task
  /** All selectable names (team members + names already in use), computed lazily on open. */
  candidates: () => string[]
  onChange: (assignees: string[]) => void
  /** Prompt for a brand-new assignee name; resolves null if cancelled. */
  promptNewName: () => Promise<string | null>
}

export class AssigneesCell {
  el: HTMLTableCellElement

  constructor(parentRow: HTMLElement, props: AssigneesCellProps) {
    this.el = parentRow.createEl('td', { cls: 'pm-table-cell pm-table-cell-assignees pm-assignees-editable' })
    if (props.task.assignees.length) {
      new AvatarStack(this.el).setNames(props.task.assignees).setMax(3)
    } else {
      this.el.createSpan({ cls: 'pm-assignees-empty', text: '+' })
    }
    setTooltip(this.el, 'Click to edit assignees')
    this.el.addEventListener('click', (e) => {
      e.stopPropagation()
      this.openMenu(e, props)
    })
  }

  private openMenu(e: MouseEvent, props: AssigneesCellProps): void {
    const { task } = props
    const menu = new Menu()
    for (const name of props.candidates()) {
      const checked = task.assignees.includes(name)
      menu.addItem((item) =>
        item
          .setTitle(displayName(name))
          .setChecked(checked)
          .onClick(() => {
            const next = checked ? task.assignees.filter((a) => a !== name) : [...task.assignees, name]
            props.onChange(next)
          })
      )
    }
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle('Add new…')
        .setIcon('plus')
        .onClick(async () => {
          const name = (await props.promptNewName())?.trim()
          if (name && !task.assignees.includes(name)) props.onChange([...task.assignees, name])
        })
    )
    if (task.assignees.length) {
      menu.addItem((item) =>
        item
          .setTitle('Clear')
          .setIcon('x')
          .onClick(() => props.onChange([]))
      )
    }
    menu.showAtMouseEvent(e)
  }
}
