import type { App } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { makeFakeApp } from '../../test/fakeVault'
import { makeProject, makeTask, type StatusConfig } from '../types'
import { ProjectStore } from './ProjectStore'
import { flattenTasks } from './TaskTreeOps'
import { buildUberProject } from './UberProject'

const STATUSES: StatusConfig[] = [{ id: 'todo', label: 'Todo', color: '#888', icon: 'circle', complete: false }]

function projectWith(title: string, path: string, titles: string[]) {
  const project = makeProject(title, path)
  project.tasks = titles.map((t) => makeTask({ title: t }))
  return project
}

describe('buildUberProject', () => {
  it('nests each project under a heading row, alphabetically', () => {
    const uber = buildUberProject([
      projectWith('Zebra', 'Projects/Zebra.md', ['z1']),
      projectWith('Athlon', 'Projects/Athlon.md', ['a1', 'a2'])
    ])

    expect(uber.project.tasks.map((t) => t.title)).toEqual(['Athlon', 'Zebra'])
    expect(uber.project.tasks[0].subtasks.map((t) => t.title)).toEqual(['a1', 'a2'])
  })

  it('resolves the owning project for every task, so writes can be delegated', () => {
    const athlon = projectWith('Athlon', 'Projects/Athlon.md', ['a1'])
    athlon.tasks[0].subtasks = [makeTask({ title: 'deep' })]
    const zebra = projectWith('Zebra', 'Projects/Zebra.md', ['z1'])

    const uber = buildUberProject([athlon, zebra])

    for (const { task } of flattenTasks(athlon.tasks)) expect(uber.ownerOf.get(task.id)).toBe(athlon)
    expect(uber.ownerOf.get(zebra.tasks[0].id)).toBe(zebra)
  })

  it('marks the heading rows so views can tell them from real work', () => {
    const uber = buildUberProject([projectWith('Athlon', 'Projects/Athlon.md', ['a1'])])
    const [heading] = uber.project.tasks

    expect(uber.headings.has(heading.id)).toBe(true)
    expect(uber.headings.has(heading.subtasks[0].id)).toBe(false)
    expect(heading.start).toBe('') // carries no dates of its own
  })

  it('keeps heading ids stable across rebuilds, so collapse state survives', () => {
    const source = projectWith('Athlon', 'Projects/Athlon.md', ['a1'])
    expect(buildUberProject([source]).project.tasks[0].id).toBe(buildUberProject([source]).project.tasks[0].id)
  })

  it('shares tasks by reference, so an edit through the owner shows up here', () => {
    const source = projectWith('Athlon', 'Projects/Athlon.md', ['a1'])
    const uber = buildUberProject([source])

    source.tasks[0].title = 'Renamed in its own project'

    expect(uber.project.tasks[0].subtasks[0].title).toBe('Renamed in its own project')
  })

  it('is not file-backed, so saving it cannot overwrite a real project', async () => {
    const { app, vault } = makeFakeApp()
    const store = new ProjectStore(app as unknown as App, () => STATUSES)
    const real = await store.createProject('Athlon', 'Projects')
    const uber = buildUberProject([real])
    vault.resetCounts()

    // The failure that matters: flattening several projects into one file.
    await store.saveProject(uber.project)

    expect(uber.project.filePath).toBe('')
    expect(vault.modifyCount.get('Projects/Athlon.md') ?? 0).toBe(0)
    expect([...vault.modifyCount.keys()]).toEqual([])
  })

  it('unions the team members so avatars resolve across projects', () => {
    const a = projectWith('A', 'Projects/A.md', [])
    a.teamMembers = ['Ada']
    const b = projectWith('B', 'Projects/B.md', [])
    b.teamMembers = ['Grace', 'Ada']

    expect(buildUberProject([a, b]).project.teamMembers).toEqual(['Ada', 'Grace'])
  })
})

describe('buildUberProject — narrowed to what a filter left', () => {
  it('shows only the narrowed tasks but still owns them through the real project', () => {
    const source = projectWith('Athlon', 'Projects/Athlon.md', ['keep', 'drop'])
    const kept = [source.tasks[0]]

    const uber = buildUberProject([source], () => kept)

    expect(uber.project.tasks[0].subtasks.map((t) => t.title)).toEqual(['keep'])
    // The owner is the project object that was passed in, not a copy of it — a write has
    // to reach the whole file, including the task the filter hid.
    expect(uber.ownerOf.get(kept[0].id)).toBe(source)
    expect(uber.sources[0]).toBe(source)
    expect(source.tasks.map((t) => t.title)).toEqual(['keep', 'drop']) // untouched
  })

  it('resolves ids from a filtered copy of the tree back to the real project', () => {
    const source = projectWith('Athlon', 'Projects/Athlon.md', ['a'])
    // What applyTaskFilterPromote hands back: same ids, different objects.
    const copies = source.tasks.map((t) => ({ ...t, subtasks: [] }))

    const uber = buildUberProject([source], () => copies)

    expect(uber.ownerOf.get(copies[0].id)).toBe(source)
  })
})

/*
 * The all-projects view is read-only and has no business syncing: a sync belongs to a real
 * project, with a file to write and a connector config to sync against. Two properties
 * keep the synthetic project out of every such path, and both are easy to undo by
 * accident — copying `ext` across "so badges work", or giving it a path "so it can be
 * saved" — so they are stated here rather than left implicit.
 */
describe('the synthetic project cannot be written or synced', () => {
  const uber = (): ReturnType<typeof buildUberProject> => {
    const source = projectWith('Alpha', 'Projects/Alpha.md', ['a1'])
    // A real connector config on the source, so "the synthetic one has none" is a fact
    // about the build and not about the fixture having nothing to copy.
    source.ext = { jira: { enabled: true, serverId: 's1', epicId: 'DEMO-100' } }
    return buildUberProject([source])
  }

  it('carries no connector config, so no connector is ever active for it', () => {
    // `activeFor` and `isEnabled` both read the project's ext bag; with none, a sync can't
    // even be built for it, let alone run.
    expect(uber().project.ext).toBeUndefined()
  })

  it('has no file path, so saveProject refuses it', () => {
    expect(uber().project.filePath).toBe('')
  })

  it('routes every row to a real project that does have a file', () => {
    const { project, ownerOf } = uber()
    for (const { task } of flattenTasks(project.tasks)) {
      const owner = ownerOf.get(task.id)
      expect(owner).toBeDefined()
      expect(owner?.filePath).toBeTruthy()
    }
  })
})
