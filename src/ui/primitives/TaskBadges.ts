import type { TaskBadge } from '../../types'
import { Chip } from './Chip'

/**
 * Render task badges (e.g. a linked issue key) as small outline chips, shown the same way
 * in the table, the gantt label column and on kanban cards. A badge with an `href` becomes
 * an external link; its click is stopped from bubbling so following the link never also
 * triggers the row/card behind it (which would open the task modal).
 */
export function renderTaskBadges(parent: HTMLElement, badges: readonly TaskBadge[] | undefined): void {
  for (const badge of badges ?? []) {
    if (!badge.href) {
      new Chip(parent).setLabel(badge.label).setVariant('outline').setSize('sm')
      continue
    }
    const link = parent.createEl('a', { href: badge.href, cls: 'pm-task-badge-link' })
    link.setAttr('target', '_blank')
    link.setAttr('rel', 'noopener')
    link.addEventListener('click', (e) => e.stopPropagation())
    new Chip(link).setLabel(badge.label).setVariant('outline').setSize('sm')
  }
}
