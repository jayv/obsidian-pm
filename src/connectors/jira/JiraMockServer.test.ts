import { requestUrl } from 'obsidian'
import { afterEach, describe, expect, it } from 'vitest'
import { JiraClient } from './JiraClient'
import { JiraMockStore, emptyDb } from './JiraMock'
import { JiraMockServer } from './JiraMockServer'

describe('JiraMockServer + real JiraClient (full HTTP path) [HTTP]', () => {
  let server: JiraMockServer
  afterEach(() => server.stop())

  async function connect(store: JiraMockStore): Promise<JiraClient> {
    server = new JiraMockServer(
      () => Promise.resolve(store),
      () => Promise.resolve()
    )
    await server.start()
    return new JiraClient({
      site: 'localhost',
      email: 'x',
      token: '',
      baseUrl: `http://127.0.0.1:${server.port}/rest/api/3`
    })
  }

  it('round-trips create / read / transition / edit / properties / search over HTTP', async () => {
    const store = new JiraMockStore(emptyDb('DEMO'), () => '2026-06-27T12:00:00.000+0000')
    store.registerStatus('To Do')
    store.registerStatus('Done')
    const client = await connect(store)

    expect((await client.testConnection()).ok).toBe(true)

    // The start field id is discovered via createmeta, not hardcoded.
    const startField = await client.startFieldId('DEMO-1')
    expect(startField).toMatch(/^customfield_/)

    const created = await client.createIssue({
      project: { key: 'DEMO' },
      issuetype: { name: 'Story' },
      summary: 'Build widget',
      parent: { key: 'DEMO-100' },
      priority: { name: 'High' },
      [startField]: '2026-07-01'
    })
    const key = 'key' in created ? created.key : ''
    expect(key).toBe('DEMO-1')

    const issue = await client.getIssue(key)
    expect(issue?.summary).toBe('Build widget')
    expect(issue?.priority).toBe('High')
    expect(issue?.start).toBe('2026-07-01') // read back from the discovered custom field

    expect(await client.transitionTo(key, 'Done')).toBe(true)
    expect((await client.getIssue(key))?.status).toBe('Done')

    expect(await client.editIssue(key, { summary: 'Build widget v2' })).toBe(true)
    expect((await client.getIssue(key))?.summary).toBe('Build widget v2')

    await client.setProperty(key, 'obsidian-pm', { status: 'Done' })
    expect(await client.getProperty(key, 'obsidian-pm')).toEqual({ status: 'Done' })

    expect((await client.epicChildren('DEMO-100')).map((i) => i.key)).toContain('DEMO-1')
    expect((await client.priorities()).map((p) => p.name)).toContain('High')
  })

  it('round-trips a dependency link (createLink → blockedBy) over HTTP', async () => {
    const store = new JiraMockStore(emptyDb('DEMO'), () => '2026-06-27T12:00:00.000+0000')
    store.registerStatus('To Do')
    const client = await connect(store)
    const a = await client.createIssue({ project: { key: 'DEMO' }, issuetype: { name: 'Story' }, summary: 'A' })
    const b = await client.createIssue({ project: { key: 'DEMO' }, issuetype: { name: 'Story' }, summary: 'B' })
    const aKey = 'key' in a ? a.key : ''
    const bKey = 'key' in b ? b.key : ''

    expect(await client.createLink(aKey, bKey)).toBe(true) // A is blocked by B
    const a2 = await client.getIssue(aKey)
    expect(a2?.blockedBy).toEqual([bKey])
    expect((await client.getIssue(bKey))?.blockedBy).toEqual([])

    // Delete the link by id → both sides clear.
    const linkId = a2?.blockLinks[0]?.id ?? ''
    expect(await client.deleteLink(linkId)).toBe(true)
    expect((await client.getIssue(aKey))?.blockedBy).toEqual([])
  })

  /*
   * The one fact in the whole link path that has to come from outside the codebase.
   *
   * `createLink` and this server's POST route both have to decide which key goes in
   * `inwardIssue` and which in `outwardIssue`. When they agreed with each other and BOTH
   * disagreed with Jira, every other link test still passed — and real Jira got every
   * dependency reversed. This pins the raw POST → GET pairing, with no meaning attached
   * and no client involved, to what a live instance actually did:
   *
   *   POST { inwardIssue: A, outwardIssue: B }
   *     → GET B shows { inwardIssue: A }   and Jira renders that as "B is blocked by A"
   *     → GET A shows { outwardIssue: B }  and renders as "A blocks B"
   *
   * So the payload's OUTWARD issue is the blocked one. Read the slot names as the roles
   * they describe and you get it exactly backwards.
   */
  it('models the live POST → GET pairing for a Blocks link (raw payload, no client)', async () => {
    const store = new JiraMockStore(emptyDb('DEMO'), () => '2026-06-27T12:00:00.000+0000')
    store.registerStatus('To Do')
    await connect(store)
    const a = store.createIssue({ issuetype: { name: 'Story' }, summary: 'A' }).key
    const b = store.createIssue({ issuetype: { name: 'Story' }, summary: 'B' }).key

    const res = await requestUrl({
      url: `http://127.0.0.1:${server.port}/rest/api/3/issueLink`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: { name: 'Blocks' }, inwardIssue: { key: a }, outwardIssue: { key: b } })
    })
    expect(res.status).toBe(201)

    type Entry = { inwardIssue?: { key: string }; outwardIssue?: { key: string } }
    const linksOf = (key: string): Entry[] => (store.getIssue(key)?.fields.issuelinks as Entry[]) ?? []
    expect(linksOf(b).map((l) => l.inwardIssue?.key)).toEqual([a])
    expect(linksOf(a).map((l) => l.outwardIssue?.key)).toEqual([b])
  })

  it('paginates GET /search/jql via nextPageToken (current Cloud endpoint)', async () => {
    const store = new JiraMockStore(emptyDb('DEMO'), () => '2026-06-27T12:00:00.000+0000')
    store.registerStatus('To Do')
    const client = await connect(store)
    for (const n of [1, 2, 3]) {
      await client.createIssue({ issuetype: { name: 'Story' }, summary: `S${n}`, parent: { key: 'DEMO-100' } })
    }
    const base = `http://127.0.0.1:${server.port}/rest/api/3/search/jql`
    const jql = encodeURIComponent('parent = "DEMO-100"')
    type Page = { issues: unknown[]; isLast: boolean; nextPageToken?: string }
    const get = async (token?: string): Promise<Page> =>
      (await requestUrl({ url: `${base}?jql=${jql}&maxResults=1${token ? `&nextPageToken=${token}` : ''}` }))
        .json as Page

    const p1 = await get()
    expect(p1.issues).toHaveLength(1)
    expect(p1.isLast).toBe(false)
    expect(p1.nextPageToken).toBeTruthy()
    const p2 = await get(p1.nextPageToken)
    expect(p2.isLast).toBe(false)
    const p3 = await get(p2.nextPageToken)
    expect(p3.isLast).toBe(true)
    expect(p3.nextPageToken).toBeUndefined()
  })

  it('nests imported sub-tasks under their parent (isSubtask from issuetype name)', async () => {
    const store = new JiraMockStore(emptyDb('DEMO'), () => '2026-06-27T12:00:00.000+0000')
    store.registerStatus('To Do')
    const client = await connect(store)
    const story = await client.createIssue({ project: { key: 'DEMO' }, issuetype: { name: 'Story' }, summary: 'P' })
    const storyKey = 'key' in story ? story.key : ''
    await client.createIssue({
      project: { key: 'DEMO' },
      issuetype: { name: 'Sub-task' },
      summary: 'child',
      parent: { key: storyKey }
    })
    const subs = await client.subtasksOf([storyKey])
    expect(subs).toHaveLength(1)
    expect(subs[0].isSubtask).toBe(true)
    expect(subs[0].parentKey).toBe(storyKey)
  })
})
