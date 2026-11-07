# Project Manager plugin API

Design spec for the public surface other Obsidian plugins use to drive tasks. The
first consumer is **obsidian-assistant**, which relays the "brain" session's edits.

Everything below is live in `src/api.ts` (tests in `src/api.test.ts`). Items first
specified as "planned" shipped on 2026-11-06.

## Principles

1. **Never touch task notes on disk.** The note body is the task description and is
   pushed to Jira verbatim; the tree is rebuilt from `subtaskIds`/`parent`; every write
   must pass the same validation and dirty-tracking the views use. The API is the only
   supported way in.
2. **Snapshots out, refs in.** Results are plain objects, never live store objects.
   A task `ref` is its vault path (`.md` optional) or its id. A `projectPath` is the
   project note's vault path (`.md` optional).
3. **Jira rules are the UI's rules.** Importing, linking, placing and pushing through
   the API behaves exactly as the same action in the import dialog or a row drag: same
   field mapping, same shadow baseline, same hierarchy limits, same push on next sync.
4. **Fail loudly, with a code.** Bad input throws `PMApiError` with a stable `code`;
   nothing is written on a rejected call.

## Entry point

```ts
const pm = app.plugins.plugins['project-manager'].api   // PluginApi
```

Everything returns a Promise. Reload-safe: the object is recreated on plugin load, so
look it up per call rather than caching it across reloads.

## Errors

```ts
class PMApiError extends Error {
  code:
    | 'not-found'        // unknown ref / projectPath / issue key
    | 'invalid'          // bad field or value (message says which)
    | 'jira-disabled'    // project has no enabled Jira connector
    | 'jira-unreachable' // client could not reach the server (message carries the reason)
    | 'out-of-scope'     // issue is not under the project's mapped Jira root
    | 'too-deep'         // Jira hierarchy can't hold a task at that depth
    | 'conflict'         // the task is in a Jira conflict; resolve it in the UI first
}
```

`code` is the contract; `message` is for humans and starts with `project-manager:`.

## Types

```ts
interface ProjectSnapshot {
  id: string
  title: string
  filePath: string
  taskCount: number
  jira: { serverId: string; rootKey: string } | null   // null when Jira is not enabled
}

interface TaskSnapshot {
  id: string
  title: string
  description: string            // the note body, Markdown
  type: 'task' | 'milestone' | 'subtask'
  status: string                 // a status id from plugin settings
  priority: 'critical' | 'high' | 'medium' | 'low'
  start: string                  // YYYY-MM-DD or ''
  due: string                    // YYYY-MM-DD or ''
  progress: number               // 0-100
  completed: string              // YYYY-MM-DD or ''
  assignees: string[]
  tags: string[]
  archived: boolean
  filePath: string | null
  parentId: string | null
  subtaskIds: string[]
  projectPath: string
  projectTitle: string
  jira: {                        // null for an unlinked task
    key: string
    sync: boolean                // opted into sync
    conflict: boolean            // needs the merge editor before further pushes
  } | null
}

/** The only keys updateTask / createTask accept. */
interface TaskPatch {
  title?: string                 // non-empty
  description?: string           // replaces the note body
  status?: string                // a status id (default ids: todo, in-progress, blocked, review, done, cancelled)
  priority?: 'critical' | 'high' | 'medium' | 'low'
  start?: string                 // YYYY-MM-DD or '' to clear
  due?: string
  progress?: number              // integer 0-100
  assignees?: string[]           // trimmed, empties dropped; must match roster spelling
  tags?: string[]
}
```

## Methods

### Read

| Method | Returns | Notes |
|---|---|---|
| `listProjects()` | `ProjectSnapshot[]` | alphabetical |
| `listTasks(projectPath?)` | `TaskSnapshot[]` | flattened, parents before children; all projects when omitted |
| `getTask(ref)` | `TaskSnapshot \| null` | |

### Write

| Method | Returns | Notes |
|---|---|---|
| `updateTask(ref, patch)` | `TaskSnapshot` | validated, saved, views refreshed. Moving to a complete status stamps `completed` and sets progress 100. |
| `createTask(projectPath, fields, parentRef?)` | `TaskSnapshot` | `fields` is a `TaskPatch`; parent must be in the same project. |

`createTask` takes a fourth argument `opts?: { sync?: boolean }`. In a Jira-enabled
project a new task defaults to `sync: true` (created in Jira on the next sync, like a
task made in the UI); pass `false` to keep it local only. `updateTask` refuses with
`conflict` while the task is in a Jira conflict.

### Jira

```ts
importJiraIssue(issueKey: string, opts?: {
  projectPath?: string   // omit: the project whose Jira root is an ancestor of the issue
  parent?: string        // task ref; omit: follow the issue's own Jira parent
}): Promise<{ task: TaskSnapshot; created: boolean }>
```

- Fetches the issue from the project's Jira server, maps status/priority/assignee with
  the project's maps, writes the description as the body, links it (`jira.key`, sync on)
  and records the shadow baseline. Identical to picking the row in the import dialog.
- **Idempotent.** If the key is already a task in that project, returns it with
  `created: false` and changes nothing.
- **Placement.** Default: under the local task that is the issue's Jira parent, or
  top-level when the parent is the root or not imported. With `parent`: placed there
  locally; the next sync moves the issue in Jira too, exactly as dragging the row would.
  Throws `too-deep` when the Jira hierarchy can't hold it there (Epic → Task → Sub-task
  is the limit under an Epic root).
- **Scope.** The issue must be inside the project's mapped root subtree, else
  `out-of-scope`. With `projectPath` omitted and no project matching, `not-found`.
- Dependencies (`blockedBy`) to already-imported issues are wired; others are ignored.

```ts
syncProject(projectPath: string): Promise<{
  jiraCreated: number; jiraUpdated: number; obsidianUpdated: number
  conflicts: number; newIssues: string[]   // keys offered for import, not imported
}>
```

Runs a full sync now instead of waiting for the next tick, silently (no progress
popup, no import dialog). Use it after a batch of `updateTask` calls when the Jira side
has to reflect them immediately. Conflicts are reported, not opened.

### Open the UI

```ts
openTask(ref: string, opts?: {
  where?: 'both' | 'project' | 'modal'   // default 'both'
  view?: 'table' | 'gantt' | 'kanban'    // switch the project view first
}): Promise<boolean>
```

- `'modal'`: the task editor dialog over whatever is open.
- `'project'`: open or reveal the project's tab (never a second tab of the same
  project), switch to `view` if given, scroll the task's row into view and highlight it.
- `'both'`: project behind, editor in front, so closing the dialog leaves the user on
  the task's row. This is the default because it is what "open the task details" means
  from a dashboard.
- `false` when the ref is unknown; nothing opens.

```ts
openProject(projectPath: string, opts?: { view?: 'table' | 'gantt' | 'kanban' }): Promise<boolean>
```

Protocol handler, for links and buttons that cannot call the API:
`obsidian://project-manager?task=<ref>[&where=modal|project|both][&view=…]` and
`obsidian://project-manager?project=<path>`. Values URL-encoded.

### Change notifications

```ts
onChange(cb: (e: { kind: 'task' | 'project'; projectPath: string; taskId?: string }) => void): () => void
```

Fires after any save the plugin makes, whether from the UI, a sync, or the API, so a
dashboard can refresh without polling. Returns the unsubscribe function. No payload
beyond the ids: call `getTask` for the fresh snapshot.

## Out of scope, by design

Move/reparent, delete, archive, dependency edits, custom fields, project creation and
Jira unlink. Each has UI affordances with confirmations the API would bypass. Ask the
project-manager side if one is needed and it is added here first.

## Assistant-side contract

What obsidian-assistant implements against this:

1. Resolve the plugin per call: `app.plugins.plugins['project-manager']?.api`; treat
   `undefined` as "plugin disabled" and say so rather than falling back to file edits.
2. For a brain request "import PROJ-123 under task X": `importJiraIssue('PROJ-123',
   { parent: X })`; then `updateTask` for any extra fields; optionally `syncProject`.
3. For "update description/state": `updateTask(ref, { description | status })`. Never
   write the note. Status values are ids; map labels on the assistant side if brain
   speaks labels.
4. Dashboard card click: `openTask(ref)` (default `'both'`).
5. Surface `PMApiError.code` to brain verbatim, with the message, so it can decide
   (e.g. `conflict` → tell Jo to resolve in the merge editor).
6. Subscribe with `onChange` once per plugin load to refresh cards.

## Testing

`src/api.test.ts` drives the API over the real store on an in-memory vault, with the
Jira paths running against the plugin's in-process Jira mock. For a live round trip use
a project with Jira off (e.g. `Projects/API Sandbox`) so nothing reaches a real instance.
