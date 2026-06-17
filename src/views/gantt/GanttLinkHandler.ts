import { Notice } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task } from '../../types'
import { safeAsync, svgEl } from '../../utils'

export interface LinkState {
  active: boolean
  taskId: string | null
  side: 'left' | 'right' | null
  dotEl: SVGElement | null
}

export function makeLinkState(): LinkState {
  return { active: false, taskId: null, side: null, dotEl: null }
}

/**
 * Cancel linking mode: reset state and remove highlight from the active dot.
 */
export function cancelLink(link: LinkState): void {
  if (link.dotEl) link.dotEl.classList.remove('pm-gantt-link-dot--active')
  link.active = false
  link.taskId = null
  link.side = null
  link.dotEl = null
}

export interface LinkDragCtx {
  svgEl: SVGSVGElement
  plugin: PMPlugin
  project: Project
  onRefresh: () => Promise<void>
}

/**
 * Drag-to-link: press on a link dot, drag a ghost connector to any task bar,
 * and release to create a finish-to-start dependency. The bar under the cursor
 * is highlighted while it is a valid drop target.
 *
 * Right dot = "this finishes → target starts" (this is the predecessor).
 * Left dot  = "this starts after target finishes" (target is the predecessor).
 */
export function attachLinkDrag(
  dotEl: SVGCircleElement,
  sourceTaskId: string,
  side: 'left' | 'right',
  ctx: LinkDragCtx
): () => void {
  let cleanup: (() => void) | null = null

  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()

    const svg = ctx.svgEl
    const startX = parseFloat(dotEl.getAttribute('cx') ?? '0')
    const startY = parseFloat(dotEl.getAttribute('cy') ?? '0')

    const ghost = svgEl('line', {
      x1: startX,
      y1: startY,
      x2: startX,
      y2: startY,
      class: 'pm-gantt-link-ghost'
    })
    svg.appendChild(ghost)
    dotEl.classList.add('pm-gantt-link-dot--active')

    let targetGroup: Element | null = null

    const highlightEl = (group: Element): Element | null =>
      group.matches('.pm-gantt-bar, .pm-gantt-milestone')
        ? group
        : group.querySelector('.pm-gantt-bar, .pm-gantt-milestone')

    const clearTarget = () => {
      if (targetGroup) {
        highlightEl(targetGroup)?.classList.remove('pm-gantt-link-target')
        targetGroup = null
      }
    }

    // Convert a screen point into the SVG's user coordinate space.
    const toSvg = (clientX: number, clientY: number): { x: number; y: number } => {
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return { x: clientX, y: clientY }
      const p = pt.matrixTransform(ctm.inverse())
      return { x: p.x, y: p.y }
    }

    const targetUnder = (clientX: number, clientY: number): Element | null => {
      const el = activeDocument.elementFromPoint(clientX, clientY)
      const group = el?.closest('[data-task-id]') ?? null
      const id = group?.getAttribute('data-task-id')
      return group && id && id !== sourceTaskId ? group : null
    }

    const teardown = () => {
      activeDocument.removeEventListener('mousemove', onMove)
      activeDocument.removeEventListener('mouseup', onUp)
      activeDocument.removeEventListener('keydown', onKey)
      ghost.remove()
      dotEl.classList.remove('pm-gantt-link-dot--active')
      clearTarget()
      cleanup = null
    }

    const onMove = (ev: MouseEvent) => {
      const { x, y } = toSvg(ev.clientX, ev.clientY)
      ghost.setAttribute('x2', String(x))
      ghost.setAttribute('y2', String(y))

      const group = targetUnder(ev.clientX, ev.clientY)
      if (group !== targetGroup) {
        clearTarget()
        if (group) {
          highlightEl(group)?.classList.add('pm-gantt-link-target')
          targetGroup = group
        }
      }
    }

    const onUp = safeAsync(async (ev: MouseEvent) => {
      const group = targetUnder(ev.clientX, ev.clientY)
      const targetId = group?.getAttribute('data-task-id') ?? null
      teardown()
      if (!targetId) return

      const predecessorId = side === 'right' ? sourceTaskId : targetId
      const successorId = side === 'right' ? targetId : sourceTaskId
      await linkTasks(predecessorId, successorId, ctx.plugin, ctx.project, ctx.onRefresh)
    })

    const onKey = (ke: KeyboardEvent) => {
      if (ke.key === 'Escape') teardown()
    }

    activeDocument.addEventListener('mousemove', onMove)
    activeDocument.addEventListener('mouseup', onUp)
    activeDocument.addEventListener('keydown', onKey)
    cleanup = teardown
  }

  dotEl.addEventListener('mousedown', onDown)

  return () => {
    dotEl.removeEventListener('mousedown', onDown)
    if (cleanup) cleanup()
  }
}

/**
 * Create a finish-to-start dependency (successor depends on predecessor),
 * guarding against duplicates and cycles. Shows a Notice on each outcome.
 */
async function linkTasks(
  predecessorId: string,
  successorId: string,
  plugin: PMPlugin,
  project: Project,
  onRefresh: () => Promise<void>
): Promise<void> {
  const allTasks = flattenAll(project.tasks)
  const successor = allTasks.find((t) => t.id === successorId)
  if (successor?.dependencies?.includes(predecessorId)) {
    new Notice('This dependency already exists.')
    return
  }

  const predecessor = allTasks.find((t) => t.id === predecessorId)
  if (predecessor?.dependencies?.includes(successorId)) {
    new Notice('Reverse dependency exists — would create a cycle.')
    return
  }

  const deps = [...(successor?.dependencies ?? []), predecessorId]
  try {
    await plugin.store.updateTask(project, successorId, { dependencies: deps })
  } catch (err) {
    new Notice('Failed to save dependency.')
    console.error('GanttLinkHandler: save failed', err)
    return
  }
  if (plugin.settings.autoSchedule) {
    await plugin.store.scheduleAfterChange(project, successorId, plugin.settings.statuses)
  }
  await onRefresh()
}

// Simple flatten helper (avoids circular import with TaskTreeOps)
function flattenAll(tasks: Task[]): Task[] {
  const result: Task[] = []
  const walk = (list: Task[]) => {
    for (const t of list) {
      result.push(t)
      if (t.subtasks.length) walk(t.subtasks)
    }
  }
  walk(tasks)
  return result
}
