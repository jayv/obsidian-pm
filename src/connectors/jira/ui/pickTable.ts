/**
 * A small selectable table shared by the Jira import/export pickers: a leading
 * checkbox column with a select-all header, then caller-defined data columns. Items
 * default to selected; `picks` (keyed by `keyOf`) is mutated in place.
 *
 * Deliberately NOT the project TableView — that one is bound to the live store
 * (virtual scrolling, inline edits, bulk actions over real Tasks); these dialogs just
 * need a clean, static, styled list of remote issues / candidate tasks to tick.
 */
import { Avatar, displayName } from '../../../ui/primitives/Avatar'
import { Chip } from '../../../ui/primitives/Chip'
import { formatBadgeText, formatDateLong } from '../../../utils'
import { Temporal, parsePlainDate, today } from '../../../dates'

/**
 * Assignee cell: a coloured avatar + name, mirroring the main task grid — `roster` keeps
 * the initials identical to the rest of the project (see projectRoster).
 */
export function pickAssigneeCell(
  cell: HTMLElement,
  name: string | null | undefined,
  roster?: Map<string, string>
): void {
  if (!name) {
    cell.setText('—')
    return
  }
  const wrap = cell.createDiv('pm-pick-assignee-cell')
  new Avatar(wrap).setName(name, roster)
  wrap.createSpan({ text: displayName(name) })
}

/**
 * Due-date cell, matching the grid's DueDateCell: a long-date chip coloured by urgency
 * — red (overdue) / orange (within 3 days) / plain. A `complete` task is never overdue.
 */
export function pickDueCell(cell: HTMLElement, iso: string | null | undefined, complete = false): void {
  if (!iso) {
    cell.setText('—')
    return
  }
  const chip = new Chip(cell).setLabel(formatDateLong(iso))
  const due = parsePlainDate(iso)
  if (due) {
    const overdue = !complete && Temporal.PlainDate.compare(due, today()) < 0
    const near = !overdue && due.since(today(), { largestUnit: 'days' }).days < 3
    if (overdue) chip.setVariant('solid').setColor('var(--color-red)').setStrong()
    else if (near) chip.setVariant('solid').setColor('var(--color-orange)')
  }
}

/**
 * Status cell as a chip, matching the grid's status badge. With a `color` (our own
 * statuses) it renders solid + icon/dot; without one (an unmapped raw Jira status) it
 * falls back to a neutral outline chip.
 */
export function pickStatusCell(cell: HTMLElement, label: string, opts: { color?: string; icon?: string } = {}): void {
  if (!label) {
    cell.setText('—')
    return
  }
  const chip = new Chip(cell).setLabel(opts.icon ? formatBadgeText(opts.icon, label) : label)
  if (opts.color) chip.setColor(opts.color).setVariant('solid').setDot(!opts.icon)
  else chip.setColor('var(--text-muted)').setVariant('outline')
}

export interface PickColumn<T> {
  header: string
  /** Populate the cell for `item`. */
  render: (item: T, cell: HTMLElement) => void
  /** Extra class on the <th>/<td> (e.g. for width/alignment). */
  cls?: string
}

export interface PickTableOpts<T> {
  parent: HTMLElement
  items: T[]
  keyOf: (item: T) => string
  picks: Map<string, boolean>
  columns: PickColumn<T>[]
  empty: string
  /** Total columns (incl. the checkbox), for a full-width sub-row's colspan. */
  colSpan?: number
  /** Called after each item's row; may insert a sub-row via `row.after(...)`. */
  afterRow?: (item: T, row: HTMLTableRowElement) => void
}

export function renderPickTable<T>(opts: PickTableOpts<T>): void {
  const { parent, items, keyOf, picks, columns, empty, afterRow } = opts
  if (!items.length) {
    parent.createDiv('pm-modal-hint').setText(empty)
    return
  }

  const table = parent.createEl('table', { cls: 'pm-jira-pick-table' })
  const headRow = table.createEl('thead').createEl('tr')
  const selectAll = headRow.createEl('th', { cls: 'pm-pick-cb' }).createEl('input', { type: 'checkbox' })
  for (const c of columns) headRow.createEl('th', { text: c.header, cls: c.cls })

  const tbody = table.createEl('tbody')
  const rowCbs: HTMLInputElement[] = []
  const syncHeader = (): void => {
    const picked = items.filter((it) => picks.get(keyOf(it)) ?? true).length
    selectAll.checked = picked === items.length
    selectAll.indeterminate = picked > 0 && picked < items.length
  }

  for (const item of items) {
    const key = keyOf(item)
    if (!picks.has(key)) picks.set(key, true)
    const tr = tbody.createEl('tr')
    const cb = tr.createEl('td', { cls: 'pm-pick-cb' }).createEl('input', { type: 'checkbox' })
    cb.checked = picks.get(key) ?? true
    cb.addEventListener('change', () => {
      picks.set(key, cb.checked)
      syncHeader()
    })
    rowCbs.push(cb)
    for (const c of columns) c.render(item, tr.createEl('td', { cls: c.cls }))
    afterRow?.(item, tr)
  }

  selectAll.addEventListener('change', () => {
    items.forEach((item, i) => {
      picks.set(keyOf(item), selectAll.checked)
      rowCbs[i].checked = selectAll.checked
    })
    selectAll.indeterminate = false
  })
  syncHeader()
}
