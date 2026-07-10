import { describe, expect, it } from 'vitest'
import { makeProject, makeTask } from '../../types'
import type { Task } from '../../types'
import { ensureProjectCfg, taskExt, type JiraAssignee, type JiraProjectConfig, type JiraValueMap } from './types'
import {
  defaultNewTaskSync,
  dueForSync,
  isLinkChecked,
  linkTask,
  queueDirty,
  setOutbound,
  stripJira,
  unlinkTask,
  upsertAssigneeMapping
} from './taskLink'

const cfg = (over: Partial<JiraProjectConfig> = {}): JiraProjectConfig => {
  const c = ensureProjectCfg(makeProject('P', 'P.md'))
  c.enabled = true
  return Object.assign(c, over)
}
const linked = (key = 'DEMO-1'): Task => makeTask({ ext: { jira: { key, sync: true } } })

describe('task link — new-task default + checkbox state [Obsidian]', () => {
  it('defaults a brand-new task to synced', () => {
    const t = makeTask()
    defaultNewTaskSync(t, true)
    expect(taskExt(t).sync).toBe(true)
  })
  it('does not override an explicit choice or a linked task', () => {
    const optedOut = makeTask({ ext: { jira: { sync: false } } })
    defaultNewTaskSync(optedOut, true)
    expect(taskExt(optedOut).sync).toBe(false)
    const existing = makeTask() // not new
    defaultNewTaskSync(existing, false)
    expect(taskExt(existing).sync).toBeUndefined()
  })
  it('checkbox is checked for new, linked, or opted-in tasks; unchecked otherwise', () => {
    expect(isLinkChecked(makeTask(), true)).toBe(true) // new
    expect(isLinkChecked(linked(), false)).toBe(true) // has key
    expect(isLinkChecked(makeTask({ ext: { jira: { sync: true } } }), false)).toBe(true) // opted in
    expect(isLinkChecked(makeTask(), false)).toBe(false) // existing, untouched
  })
})

describe('task link — opt in / opt out [Obsidian]', () => {
  it('linkTask opts a task in', () => {
    const t = makeTask()
    linkTask(t)
    expect(taskExt(t).sync).toBe(true)
  })
  it('unlinkTask drops the jira block and ignores the key', () => {
    const c = cfg()
    const t = linked('DEMO-7')
    unlinkTask(t, c)
    expect(taskExt(t).key).toBeUndefined()
    expect(t.ext?.jira).toBeUndefined()
    expect(c.ignoredKeys).toContain('DEMO-7')
  })
  it('unlinkTask on a keyless task just removes the block (nothing to ignore)', () => {
    const c = cfg()
    const t = makeTask({ ext: { jira: { sync: true } } })
    unlinkTask(t, c)
    expect(t.ext?.jira).toBeUndefined()
    expect(c.ignoredKeys).toEqual([])
  })
  it('unlinkTask does not duplicate an already-ignored key', () => {
    const c = cfg({ ignoredKeys: ['DEMO-7'] })
    unlinkTask(linked('DEMO-7'), c)
    expect(c.ignoredKeys).toEqual(['DEMO-7'])
  })
})

describe('task link — dirty queue [Obsidian]', () => {
  it('queues a synced task in an enabled project', () => {
    const c = cfg()
    const t = linked()
    queueDirty(c, t)
    expect(c.dirtyQueue).toEqual([t.id])
  })
  it('does not queue twice', () => {
    const c = cfg()
    const t = linked()
    queueDirty(c, t)
    queueDirty(c, t)
    expect(c.dirtyQueue).toEqual([t.id])
  })
  it('ignores non-synced tasks and disabled projects', () => {
    const c = cfg()
    queueDirty(c, makeTask()) // not synced
    expect(c.dirtyQueue ?? []).toEqual([])
    const disabled = cfg({ enabled: false })
    queueDirty(disabled, linked())
    expect(disabled.dirtyQueue ?? []).toEqual([])
  })
})

describe('task link — interval gate [Obsidian]', () => {
  it('is due when never synced', () => {
    expect(dueForSync(cfg(), 1_000_000)).toBe(true)
  })
  it('respects the interval since lastSyncAt', () => {
    const last = '2026-06-28T10:00:00.000Z'
    const c = cfg({ lastSyncAt: last, syncIntervalMin: 5 })
    const base = Date.parse(last)
    expect(dueForSync(c, base + 4 * 60_000)).toBe(false) // 4 min < 5
    expect(dueForSync(c, base + 5 * 60_000)).toBe(true) // 5 min ≥ 5
  })
})

describe('task link — disconnect [Obsidian]', () => {
  it('stripJira removes the jira block, preserving other connectors', () => {
    expect(stripJira({ jira: { key: 'DEMO-1' }, other: 1 })).toEqual({ other: 1 })
    expect(stripJira({ jira: { key: 'DEMO-1' } })).toBeUndefined() // empty → undefined
    expect(stripJira(undefined)).toBeUndefined()
  })
})

describe('mapping panel — outbound radio [Obsidian]', () => {
  it('setOutbound makes the entry the sole write-back for its target', () => {
    const map: JiraValueMap[] = [
      { jira: 'Backlog', target: 'todo', outbound: true },
      { jira: 'Selected', target: 'todo' },
      { jira: 'Done', target: 'done', outbound: true }
    ]
    setOutbound(map, map[1]) // flag "Selected"
    expect(map.find((e) => e.jira === 'Selected')?.outbound).toBe(true)
    expect(map.find((e) => e.jira === 'Backlog')?.outbound).toBe(false) // sibling cleared
    expect(map.find((e) => e.jira === 'Done')?.outbound).toBe(true) // other target untouched
  })
})

describe('mapping panel — assignee picker [Obsidian]', () => {
  const map = (): JiraAssignee[] => [{ name: 'Alice', jiraUser: 'mock:alice', jiraDisplay: 'Alice' }]

  it('appends a new member mapping', () => {
    const m = map()
    upsertAssigneeMapping(m, 'Bob', 'mock:bob', 'Bob')
    expect(m).toContainEqual({ name: 'Bob', jiraUser: 'mock:bob', jiraDisplay: 'Bob' })
  })
  it('updates an existing member in place', () => {
    const m = map()
    upsertAssigneeMapping(m, 'Alice', 'mock:alice2', 'Alice 2')
    expect(m).toEqual([{ name: 'Alice', jiraUser: 'mock:alice2', jiraDisplay: 'Alice 2' }])
  })
  it('removes the mapping when the jira user is cleared', () => {
    const m = map()
    upsertAssigneeMapping(m, 'Alice', '')
    expect(m).toEqual([])
  })
})
