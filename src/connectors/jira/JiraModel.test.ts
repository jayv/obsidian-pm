import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES } from '../../types'
import {
  epicChildrenJql,
  epicUpdatedSinceJql,
  keyInJql,
  mapInbound,
  mapOutbound,
  levelOfType,
  mergePriorityMap,
  mergeStatusMap,
  normalizeIssue,
  projectKeyOf,
  reconcileStatus,
  subtreeChangedJql,
  toJqlTime,
  typeForLevel
} from './JiraModel'
import { validateValueMap } from './types'

describe('issue-type hierarchy (create-type resolution)', () => {
  const types = [
    { name: 'Initiative', level: 2 },
    { name: 'Epic', level: 1 },
    { name: 'Story', level: 0 },
    { name: 'Task', level: 0 },
    { name: 'Sub-task', level: -1 }
  ]

  it('levelOfType matches by name, case-insensitively', () => {
    expect(levelOfType(types, 'Epic')).toBe(1)
    expect(levelOfType(types, 'sub-task')).toBe(-1)
    expect(levelOfType(types, 'Initiative')).toBe(2)
    expect(levelOfType(types, 'Bug')).toBeUndefined()
  })

  it('typeForLevel picks one type per level, preferring Task over Story at level 0', () => {
    expect(typeForLevel(types, 2)).toBe('Initiative')
    expect(typeForLevel(types, 1)).toBe('Epic')
    expect(typeForLevel(types, 0)).toBe('Task')
    expect(typeForLevel(types, -1)).toBe('Sub-task')
  })

  it('returns null when no type exists at a level (e.g. below Sub-task → too deep)', () => {
    expect(typeForLevel(types, -2)).toBeNull()
    expect(typeForLevel(types, 3)).toBeNull()
  })

  it('prefers Task when several types share level 0 (real instances have Bug/others there)', () => {
    const many = [
      { name: 'Epic', level: 1 },
      { name: 'Bug', level: 0 },
      { name: 'Chore', level: 0 },
      { name: 'Task', level: 0 },
      { name: 'Spike', level: 0 },
      { name: 'Sub-task', level: -1 }
    ]
    expect(typeForLevel(many, 0)).toBe('Task')
    // No Task/Story at the level → fall back to the first declared type.
    expect(
      typeForLevel(
        [
          { name: 'Bug', level: 0 },
          { name: 'Chore', level: 0 }
        ],
        0
      )
    ).toBe('Bug')
  })
})

describe('normalizeIssue', () => {
  it('maps the fields we care about', () => {
    const raw = {
      key: 'DEMO-42',
      fields: {
        summary: 'Build widget',
        status: { name: 'In Review', statusCategory: { name: 'In Progress' } },
        priority: { name: 'High' },
        assignee: { accountId: 'acc-1', displayName: 'Alice' },
        customfield_10015: '2026-04-15',
        duedate: '2026-05-01',
        updated: '2026-04-20T10:00:00.000+0000',
        parent: { key: 'DEMO-1' },
        issuetype: { name: 'Story', subtask: false },
        issuelinks: [
          { type: { inward: 'is blocked by' }, inwardIssue: { key: 'DEMO-7' } },
          { type: { inward: 'relates to' }, inwardIssue: { key: 'DEMO-9' } }
        ]
      }
    }
    expect(normalizeIssue(raw, 'customfield_10015')).toEqual({
      key: 'DEMO-42',
      summary: 'Build widget',
      status: 'In Review',
      statusCategory: 'In Progress',
      priority: 'High',
      assigneeAccountId: 'acc-1',
      assigneeName: 'Alice',
      start: '2026-04-15',
      due: '2026-05-01',
      updated: '2026-04-20T10:00:00.000+0000',
      parentKey: 'DEMO-1',
      issueType: 'Story',
      isSubtask: false,
      milestone: false,
      blockedBy: ['DEMO-7'],
      blockLinks: [] // no link ids in this fixture
    })
  })

  it('infers isSubtask from the issuetype name when the boolean is absent', () => {
    const sub = normalizeIssue({ key: 'DEMO-2', fields: { issuetype: { name: 'Sub-task' } } })
    expect(sub.isSubtask).toBe(true)
    const story = normalizeIssue({ key: 'DEMO-1', fields: { issuetype: { name: 'Story' } } })
    expect(story.isSubtask).toBe(false)
  })

  it('reads an assignee that has an accountId + displayName but no email', () => {
    // Jira Cloud omits emailAddress for other users by default; we key off accountId.
    const n = normalizeIssue({
      key: 'DEMO-5',
      fields: { assignee: { accountId: 'acc-9', displayName: 'Rubie' } }
    })
    expect(n.assigneeAccountId).toBe('acc-9')
    expect(n.assigneeName).toBe('Rubie')
  })

  it('keeps a non-UTC updated timestamp verbatim (offset preserved)', () => {
    const n = normalizeIssue({ key: 'DEMO-6', fields: { updated: '2026-06-29T10:48:00.642-0700' } })
    expect(n.updated).toBe('2026-06-29T10:48:00.642-0700')
  })

  it('reads the milestone flag from the inline obsidian-pm entity property', () => {
    const ms = normalizeIssue({ key: 'DEMO-1', properties: { 'obsidian-pm': { milestone: true } } })
    expect(ms.milestone).toBe(true)
    const plain = normalizeIssue({ key: 'DEMO-2', properties: { 'obsidian-pm': { milestone: false } } })
    expect(plain.milestone).toBe(false)
    expect(normalizeIssue({ key: 'DEMO-3' }).milestone).toBe(false) // no property → not a milestone
  })

  it('tolerates missing fields', () => {
    const n = normalizeIssue({ key: 'DEMO-1' })
    expect(n.summary).toBe('')
    expect(n.assigneeAccountId).toBeNull()
    expect(n.due).toBeNull()
    expect(n.blockedBy).toEqual([])
  })
})

describe('JQL builders', () => {
  it('builds epic children + incremental JQL and strips quotes from the key', () => {
    expect(epicChildrenJql('DEMO-1')).toContain('parent = "DEMO-1"')
    expect(epicChildrenJql('DEMO-1')).toContain('"Epic Link" = "DEMO-1"')
    expect(epicUpdatedSinceJql('DEMO-1', '2026-04-20 10:00')).toContain('updated > "2026-04-20 10:00"')
    expect(epicChildrenJql('EN"G-1')).not.toContain('"EN"G')
  })

  it('derives the project key', () => {
    expect(projectKeyOf('DEMO-1234')).toBe('DEMO')
    expect(projectKeyOf('ABC')).toBe('ABC')
  })

  it('builds key-in and incremental subtree JQL', () => {
    expect(keyInJql(['DEMO-1', 'DEMO-2'])).toBe('key in ("DEMO-1","DEMO-2") ORDER BY created ASC')
    const jql = subtreeChangedJql(['DEMO-1', 'DEMO-2'], 'DEMO-100', '2026-04-20T10:00:00.000+0000')
    // Tracked issues OR new children of any tracked issue / the epic, changed since the watermark.
    expect(jql).toContain('key in ("DEMO-1","DEMO-2")')
    expect(jql).toContain('parent in ("DEMO-1","DEMO-2","DEMO-100")')
    expect(jql).toContain(' OR ')
    expect(jql).toContain('updated > "2026-04-20 10:00"') // ISO collapsed to the JQL minute form
    expect(jql).toMatch(/ORDER BY updated ASC$/)
  })

  it('subtree JQL with no tracked keys scopes to the epic children only', () => {
    const jql = subtreeChangedJql([], 'DEMO-100', '')
    expect(jql).toBe('parent in ("DEMO-100") ORDER BY updated ASC') // no key-in clause, no time filter
  })

  it('toJqlTime collapses an ISO timestamp to the JQL minute form, tz offset and all', () => {
    expect(toJqlTime('2026-04-20T10:00:00.000+0000')).toBe('2026-04-20 10:00')
    expect(toJqlTime('2026-06-29T10:48:00.642-0700')).toBe('2026-06-29 10:48') // non-UTC offset
    expect(toJqlTime('2026-04-20 10:00')).toBe('2026-04-20 10:00') // already minute form → unchanged
  })
})

describe('mapInbound', () => {
  it('matches case-insensitively and falls back', () => {
    const map = [
      { jira: 'In Progress', target: 'in-progress' },
      { jira: 'Done', target: 'done' }
    ]
    expect(mapInbound(map, 'in progress', 'todo')).toBe('in-progress')
    expect(mapInbound(map, 'DONE', 'todo')).toBe('done')
    expect(mapInbound(map, 'Backlog', 'todo')).toBe('todo')
    expect(mapInbound(undefined, 'anything', 'todo')).toBe('todo')
  })

  it('supports N→1 (many JIRA values to one target)', () => {
    const map = [
      { jira: 'Backlog', target: 'todo' },
      { jira: 'Selected', target: 'todo' }
    ]
    expect(mapInbound(map, 'Backlog', 'x')).toBe('todo')
    expect(mapInbound(map, 'Selected', 'x')).toBe('todo')
  })
})

describe('mapOutbound', () => {
  it('returns the outbound-flagged value for a target', () => {
    const map = [
      { jira: 'Backlog', target: 'todo' },
      { jira: 'Selected', target: 'todo', outbound: true }
    ]
    expect(mapOutbound(map, 'todo')).toBe('Selected')
  })

  it('falls back to the first entry when none is flagged', () => {
    const map = [
      { jira: 'Backlog', target: 'todo' },
      { jira: 'Selected', target: 'todo' }
    ]
    expect(mapOutbound(map, 'todo')).toBe('Backlog')
  })

  it('returns undefined when nothing maps to the target', () => {
    expect(mapOutbound([{ jira: 'Done', target: 'done' }], 'todo')).toBeUndefined()
  })
})

describe('mergeStatusMap', () => {
  it('adds a string-match rule per JIRA status, first per target is outbound', () => {
    const map = mergeStatusMap(
      [],
      [
        { name: 'Backlog', category: 'To Do' },
        { name: 'Selected', category: 'To Do' },
        { name: 'In Progress', category: 'In Progress' },
        { name: 'Shipped', category: 'Done' }
      ],
      DEFAULT_STATUSES
    )
    expect(map).toEqual([
      { jira: 'Backlog', target: 'todo', outbound: true },
      { jira: 'Selected', target: 'todo', outbound: false },
      { jira: 'In Progress', target: 'in-progress', outbound: true },
      { jira: 'Shipped', target: 'done', outbound: true }
    ])
  })

  it('keeps existing rules and skips JIRA names already present (case-insensitive)', () => {
    const existing = [{ jira: 'Done', target: 'done', outbound: true }]
    const map = mergeStatusMap(
      existing,
      [
        { name: 'done', category: 'Done' },
        { name: 'To Do', category: 'To Do' }
      ],
      DEFAULT_STATUSES
    )
    expect(map).toEqual([
      { jira: 'Done', target: 'done', outbound: true },
      { jira: 'To Do', target: 'todo', outbound: true }
    ])
  })

  it('maps an arbitrarily-named status by its category (name has no keyword)', () => {
    // A real workflow can name its To-Do status anything; the category still drives it.
    const map = mergeStatusMap(
      [],
      [
        { name: 'Triage', category: 'To Do' },
        { name: 'Cranking', category: 'In Progress' },
        { name: 'Shipped', category: 'Done' }
      ],
      DEFAULT_STATUSES
    )
    expect(map.find((e) => e.jira === 'Triage')?.target).toBe('todo')
    expect(map.find((e) => e.jira === 'Cranking')?.target).toBe('in-progress')
    expect(map.find((e) => e.jira === 'Shipped')?.target).toBe('done')
  })
})

describe('mergePriorityMap', () => {
  it('guesses our priority and flags the first per target as outbound', () => {
    const names = ['Highest', 'High', 'Medium', 'Low', 'Lowest']
    const map = mergePriorityMap(
      [],
      names.map((name) => ({ name })),
      DEFAULT_PRIORITIES
    )
    expect(map).toEqual([
      { jira: 'Highest', target: 'critical', outbound: true },
      { jira: 'High', target: 'high', outbound: true },
      { jira: 'Medium', target: 'medium', outbound: true },
      { jira: 'Low', target: 'low', outbound: true },
      { jira: 'Lowest', target: 'low', outbound: false }
    ])
  })

  it('guesses P0–P4 style priority names (and collapses collisions to one outbound)', () => {
    const names = ['P0 - Blocker', 'P1 - Critical', 'P2 - Major', 'P3 - Low', 'P4 - Lowest']
    const map = mergePriorityMap(
      [],
      names.map((name) => ({ name })),
      DEFAULT_PRIORITIES
    )
    const target = (jira: string) => map.find((e) => e.jira === jira)?.target
    expect(target('P0 - Blocker')).toBe('critical')
    expect(target('P1 - Critical')).toBe('critical') // both P0 and P1 land on critical…
    expect(map.filter((e) => e.target === 'critical' && e.outbound)).toHaveLength(1) // …only one writes back
    expect(target('P2 - Major')).toBe('high')
    expect(target('P3 - Low')).toBe('low')
    expect(target('P4 - Lowest')).toBe('low')
  })

  it('attaches discovered ids and backfills them onto existing id-less rules', () => {
    const existing = [{ jira: 'High', target: 'high', outbound: true }] // legacy rule, no id
    const map = mergePriorityMap(
      existing,
      [
        { name: 'High', id: '2' }, // should backfill onto the existing rule
        { name: 'Low', id: '4' } // new rule carries its id
      ],
      DEFAULT_PRIORITIES
    )
    expect(map).toEqual([
      { jira: 'High', target: 'high', outbound: true, id: '2' },
      { jira: 'Low', target: 'low', outbound: true, id: '4' }
    ])
  })
})

describe('validateValueMap', () => {
  it('passes a valid N→1 map (many Jira values → one target, one flagged to write)', () => {
    expect(
      validateValueMap([
        { jira: 'Backlog', target: 'todo', outbound: true },
        { jira: 'Selected', target: 'todo' },
        { jira: 'Done', target: 'done', outbound: true }
      ])
    ).toEqual([])
  })

  it('fails when a Jira value appears in more than one rule', () => {
    const errors = validateValueMap([
      { jira: 'Blocked', target: 'todo' },
      { jira: 'Blocked', target: 'blocked', outbound: true }
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Blocked.*only once/)
  })

  it('fails when a target has more than one outbound rule', () => {
    const errors = validateValueMap([
      { jira: 'Backlog', target: 'todo', outbound: true },
      { jira: 'Selected', target: 'todo', outbound: true }
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/only one may write back/)
  })

  it('fails when an Obsidian target has no outbound (write-back) rule', () => {
    const errors = validateValueMap([{ jira: 'To Do', target: 'todo', outbound: true }], 'status', [
      { id: 'todo', label: 'To Do' },
      { id: 'done', label: 'Done' }
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Done.*no rule flagged/)
  })

  it('passes when every target has exactly one write-back rule', () => {
    const errors = validateValueMap(
      [
        { jira: 'Backlog', target: 'todo' },
        { jira: 'To Do', target: 'todo', outbound: true },
        { jira: 'Done', target: 'done', outbound: true }
      ],
      'status',
      [
        { id: 'todo', label: 'To Do' },
        { id: 'done', label: 'Done' }
      ]
    )
    expect(errors).toEqual([])
  })
})

describe('reconcileStatus', () => {
  it('is in sync when local and JIRA already agree', () => {
    expect(
      reconcileStatus({ issueStatus: 'Done', actualPMStatus: 'done', localPMStatus: 'done', localChanged: true })
    ).toEqual({ status: 'done', reconciled: true, jiraStatus: 'Done' })
  })

  it('JIRA wins when we did not change locally (teammate update)', () => {
    expect(
      reconcileStatus({ issueStatus: 'Done', actualPMStatus: 'done', localPMStatus: 'todo', localChanged: false })
    ).toEqual({ status: 'done', reconciled: true, jiraStatus: 'Done' })
  })

  it('flags limbo when we changed locally but JIRA does not reflect it', () => {
    expect(
      reconcileStatus({ issueStatus: 'To Do', actualPMStatus: 'todo', localPMStatus: 'done', localChanged: true })
    ).toEqual({ status: 'done', reconciled: false, jiraStatus: 'To Do' })
  })
})
