import type { TaskBadge } from '../../types'
import { ProgressBar } from '../primitives/ProgressBar'
import { renderTaskBadges } from '../primitives/TaskBadges'

export interface ProjectCardProps {
  title: string
  icon: string
  color: string
  tasksDone: number
  tasksTotal: number
  /** Short labels for the project (e.g. its Jira issue key), rendered beside the counts. */
  badges?: TaskBadge[]
  onClick: () => void
  onContextMenu: (e: MouseEvent) => void
}

export class ProjectCard {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: ProjectCardProps) {
    const card = parentEl.createDiv('pm-project-card')
    this.el = card

    const colorBar = card.createDiv('pm-project-card-bar')
    colorBar.setCssStyles({ background: props.color })

    const body = card.createDiv('pm-project-card-body')
    body.createDiv({ text: props.icon, cls: 'pm-project-card-icon' })
    body.createEl('h3', { text: props.title, cls: 'pm-project-card-title' })

    const meta = body.createDiv('pm-project-card-meta')
    meta.createSpan({
      text: `${props.tasksDone}/${props.tasksTotal} tasks`,
      cls: 'pm-project-card-tasks'
    })
    // Opening the issue must not also open the project behind it — renderTaskBadges stops
    // the click for linked badges, which is exactly what a card needs.
    renderTaskBadges(meta, props.badges)

    const percent = props.tasksTotal ? (props.tasksDone / props.tasksTotal) * 100 : 0
    new ProgressBar(body).setSize('sm').setValue(percent).setColor(props.color)

    card.addEventListener('click', () => props.onClick())
    card.addEventListener('contextmenu', (e) => props.onContextMenu(e))
  }
}
