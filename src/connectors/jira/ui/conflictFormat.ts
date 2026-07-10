import type { SyncField } from '../reconcile'
import type { JiraShadow } from '../types'

/** Settings slice needed to render status/priority ids as their human labels. */
export interface LabelSettings {
  statuses: { id: string; label: string }[]
  priorities: { id: string; label: string }[]
}

export const FIELD_LABEL: Record<SyncField, string> = {
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  start: 'Start date',
  due: 'Due date',
  assignees: 'Assignee',
  milestone: 'Type',
  blockedBy: 'Blocked by'
}

/** Human-readable value for a field in a shadow, resolving status/priority ids to labels. */
export function formatField(settings: LabelSettings, field: SyncField, s: JiraShadow): string {
  switch (field) {
    case 'title':
      return s.title || '—'
    case 'status':
      return settings.statuses.find((x) => x.id === s.status)?.label ?? s.status
    case 'priority':
      return settings.priorities.find((x) => x.id === s.priority)?.label ?? s.priority
    case 'start':
      return s.start || '—'
    case 'due':
      return s.due || '—'
    case 'assignees':
      return s.assignees.length ? s.assignees.join(', ') : 'Unassigned'
    case 'milestone':
      return s.milestone ? 'Milestone' : 'Task'
    case 'blockedBy':
      return s.blockedBy.length ? s.blockedBy.join(', ') : 'None'
  }
}
