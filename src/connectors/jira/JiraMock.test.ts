import { describe, expect, it } from 'vitest'
import { JiraMockStore, emptyDb, seedMeta } from './JiraMock'
import { normalizeIssue } from './JiraModel'

const newStore = () =>
  new JiraMockStore(
    emptyDb('DEMO'),
    () => '2026-06-27T12:00:00.000+0000',
    () => 0.5
  )

describe('JiraMockStore', () => {
  it('generates and keeps a start custom-field id', () => {
    const s = newStore()
    expect(s.startFieldId).toMatch(/^customfield_\d+$/)
  })

  it('creates issues with a minted key, initial status, and registered priority', () => {
    const s = newStore()
    const r = s.createIssue({ summary: 'A', priority: { name: 'High' } })
    expect(r.key).toBe('DEMO-1')
    expect(r.fields.summary).toBe('A')
    expect((r.fields.status as { name: string }).name).toBeTruthy()
    expect((r.fields.priority as { id: string; name: string }).id).toBeTruthy()
    expect(s.data.meta.priorities.map((p) => p.name)).toContain('High')
  })

  it('transitions to a registered status', () => {
    const s = newStore()
    s.registerStatus('Done')
    const r = s.createIssue({ summary: 'A' })
    const done = s.transitionsFor(r.key).find((t) => t.to.name === 'Done')
    s.applyTransition(r.key, done?.id ?? '')
    const after = s.getIssue(r.key)
    expect((after?.fields.status as { name: string } | undefined)?.name).toBe('Done')
  })

  it('seeds statuses/priorities/users from settings inputs', () => {
    const s = newStore()
    seedMeta(s, {
      statuses: [
        { name: 'To Do', complete: false },
        { name: 'Done', complete: true }
      ],
      priorities: [{ name: 'High' }],
      users: [{ accountId: 'mock:alice', displayName: 'Alice' }]
    })
    expect(s.data.meta.statuses.map((x) => x.name)).toEqual(['To Do', 'Done'])
    expect(s.data.meta.statuses[1].statusCategory.key).toBe('done') // complete → Done category
    expect(s.data.meta.priorities.map((x) => x.name)).toEqual(['High'])
    expect(s.data.meta.users[0].accountId).toBe('mock:alice')
  })

  it('ensures an epic issue with an explicit key and accepts entity properties', () => {
    const s = newStore()
    const epic = s.ensureIssue('DEMO-12344', { summary: 'My Epic', issuetype: { name: 'Epic' } })
    expect(epic.key).toBe('DEMO-12344')
    expect(epic.fields.summary).toBe('My Epic')
    // Idempotent: a second ensure returns the same record, doesn't duplicate.
    expect(s.ensureIssue('DEMO-12344', { summary: 'changed' }).fields.summary).toBe('My Epic')
    s.setProperty('DEMO-12344', 'obsidian-pm-config', { statusMap: [] })
    expect(s.getProperty('DEMO-12344', 'obsidian-pm-config')).toEqual({ statusMap: [] })
  })

  it('marks sub-task issuetype with the subtask boolean on create', () => {
    const s = newStore()
    const sub = s.createIssue({ summary: 'S', issuetype: { name: 'Sub-task' }, parent: { key: 'DEMO-1' } })
    expect((sub.fields.issuetype as { subtask?: boolean }).subtask).toBe(true)
    const story = s.createIssue({ summary: 'St', issuetype: { name: 'Story' } })
    expect((story.fields.issuetype as { subtask?: boolean }).subtask).toBe(false)
  })

  it('records a block link readable as blockedBy on the blocked issue (idempotent), then removes it', () => {
    const s = newStore()
    const a = s.createIssue({ summary: 'A' }) // blocked
    const b = s.createIssue({ summary: 'B' }) // blocker
    s.addBlockLink(a.key, b.key)
    s.addBlockLink(a.key, b.key) // no duplicate
    const linked = normalizeIssue(s.getIssue(a.key))
    expect(linked.blockedBy).toEqual([b.key])
    expect(normalizeIssue(s.getIssue(b.key)).blockedBy).toEqual([]) // blocker side isn't "blocked by"
    const linkId = linked.blockLinks[0]?.id
    expect(linkId).toBeTruthy()
    // Removing by id clears it from both issues.
    expect(s.removeLink(linkId)).toBe(true)
    expect(normalizeIssue(s.getIssue(a.key)).blockedBy).toEqual([])
    expect(s.getIssue(b.key)?.fields.issuelinks).toEqual([])
  })

  it('edits fields and stores entity properties', () => {
    const s = newStore()
    const r = s.createIssue({ summary: 'A' })
    s.editIssue(r.key, { summary: 'B' })
    expect(s.getIssue(r.key)?.fields.summary).toBe('B')
    s.setProperty(r.key, 'obsidian-pm', { status: 'Done' })
    expect(s.getProperty(r.key, 'obsidian-pm')).toEqual({ status: 'Done' })
  })
})
