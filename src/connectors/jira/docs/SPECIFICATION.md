# JIRA Connector — Specification

A precise, implementation-level specification of the JIRA connector for the Obsidian
Project Manager plugin. It is detailed enough to reproduce the current behavior
without ambiguity. JIRA-specific code lives entirely under `src/connectors/jira/`;
the core plugin knows only the generic connector interface.

> Terminology: the **local server** is an in-process HTTP server that speaks the
> JIRA REST subset for development/testing. It is an implementation detail — never
> surfaced to users as a "mock". In this document it is called the _local server_.

Contents: [Goals](#1-goals) · [Architecture](#2-architecture) ·
[Data model](#3-data-model) · [Value maps](#4-value-maps) ·
[REST client](#5-rest-client) · [Normalization](#6-issue-normalization) ·
[Local server](#7-local-server) · [Sync engine](#8-sync-engine) ·
[Import/Export](#9-import--export--linking) · [UI](#10-ui) ·
[Persistence](#11-persistence--auto-save) · [Guarantees](#12-guarantees--limitations) ·
[Testing](#13-testing) · [History](#implementation-history)

---

## 1. Goals

1. **Two-way sync** of a project's tasks ↔ a JIRA epic's child issues.
2. **No data loss on a shared instance**: a local edit never clobbers a field a
   teammate changed; a rejected write is never silently dropped.
3. **Minimal writes**; per-user state (reconciliation, watermark) stays local.
4. **One I/O path** (`JiraClient`) exercised identically against the local server
   and real JIRA.
5. **Connector isolation**: core has zero JIRA knowledge.

---

## 2. Architecture

### 2.1 Connector interface (`registry.ts`)

```
interface Connector {
  id; name
  isEnabled(project): boolean
  onload?(plugin)
  onTaskChanged?(project, task)
  onTaskDeleted?(project, task)
  onProjectLoaded?/onProjectSaved?(project)
  syncTick?(project): Promise<{changed}>
  syncNow?(project): Promise<void>
  renderGlobalSettings?(el)
  renderProjectPanel?(el, project, onClose, onChange?)
  renderTaskField?(el, task, project)
  toolbarActions?(project): {label,onClick}[]
}
interface ConnectorDescriptor { id; name; frontmatterKeys?; create(plugin): Connector }
```

`ConnectorRegistry`:

- `register(descriptor)`, `all()` (instantiate every connector — for explicit UI),
  `activeFor(project)` (instantiate only connectors whose `id` is a key in
  `project.ext`), `ownsKey(key)` (descriptor-only, never instantiates).
- Instances are built lazily once and cached; `onload` runs on first build.
- `taskChanged`/`projectLoaded`/`projectSaved` fan out to `activeFor` only.

The JIRA descriptor: `id = "jira"`, `frontmatterKeys = { keys: ["jira"] }`,
`create = (plugin) => new JiraConnector(plugin)`.

### 2.2 `ext` persistence

Connector data round-trips through a namespaced `ext` block in note frontmatter.
The store serializes/hydrates `ext.jira` opaquely and migrates legacy top-level
`jira` keys into `ext` on read. Core never interprets the contents.

---

## 3. Data model (`types.ts`)

Constants: `JIRA_ID = "jira"`, `ISSUE_PROP = "obsidian-pm"`,
`CONFIG_PROP = "obsidian-pm-config"`.

### 3.1 `JiraValueMap`

```
{ jira: string; target: string; outbound?: boolean; id?: string }
```

`id` is the JIRA-side identifier (priority id / status id), discovered once at
mapping-load and persisted here so outbound writes/matches use the id, not the display
name (robust against renames + duplicate names). Absent on legacy maps → writes fall
back to `jira` (the name). Team-member ids need no analogue — `JiraAssignee.jiraUser`
already stores the accountId, which is what assignee writes push.

### 3.2 `JiraServer` (global, in plugin settings)

```
{ id; name; site; email }     // token stored separately as a secret
```

### 3.3 `JiraProjectConfig` (`project.ext.jira`)

```
enabled: boolean
serverId: string
epicId: string
statusMap: JiraValueMap[]
priorityMap: JiraValueMap[]
assigneeMap: { jiraUser: string; name: string; jiraDisplay?: string }[] // legacy — migrated out on load
ignoredKeys: string[]
dirtyQueue: string[]
mappingsDirty?: boolean
syncIntervalMin?: number
lastSyncAt?: string
lastSeenUpdated?: string
```

### 3.4 `JiraTaskExt` (`task.ext.jira`)

```
key?: string             // linked issue key; absent = unlinked
sync?: boolean           // opt-in to sync
reconciled?: boolean     // false ⇒ unresolved conflict (local & JIRA both changed)
conflict?: JiraConflict  // JIRA snapshot captured at conflict time; drives the resolve UI
shadow?: JiraShadow      // last-synced values; the common base for the 3-way merge
adfStash?: Record<string, AdfNode>  // description nodes Markdown can't hold, kept verbatim (§6.1)
outOfScope?: boolean     // archived by us because the issue left the root's subtree (§8.8)
```

```
JiraShadow   = { title; status; priority; start; due; assignees: string[]; milestone: boolean;
                 description: string; parent: string; blockedBy: string[] }
JiraConflict = { theirs: JiraShadow }   // JIRA side at detection; the live diff is recomputed in the UI
```

`blockedBy` holds the JIRA keys the task is "blocked by" (its dependencies), so links
are merged field-by-field like everything else.

`description` is the note's body as Markdown (Jira stores an ADF tree — §6.1).
`parent` is the **JIRA key** of the parent issue, or the mapped root's key for a
top-level task: the only name both sides can agree on, and one that survives a task
being re-imported with a new local id.

### 3.5 Entity-property bags (stored on JIRA issues)

- `ISSUE_PROP` on each issue — `{ milestone?: boolean }`. Shared fact only.
- `CONFIG_PROP` on the epic — `{ statusMap, priorityMap }`. The shared mapping config
  other Obsidian users adopt. Assignee mappings are deliberately **not** published: they
  are name↔accountId pairs, and there is no reason to store identities in Jira.

### 3.6 Settings accessors

- `servers(plugin)`, `setServers` (preserves sibling keys), `serverById`.
- `getToken/setToken` — secret keyed `jira:{serverId}` in `connectorSecrets`.
- `getDebug/setDebug` — the API debug-logging flag.
- `assigneeMapFor(plugin, serverId)` — the **live** mapping list for one server (mutate,
  then `saveSettings`). Held per server, not per project: an `accountId` only means
  anything on the site it came from, but within a site a person is the same person on
  every project. `sharedAssignees(plugin, cfg)` returns that list and folds in any
  mappings still on the project (an older vault, or a config just adopted from the epic),
  then clears `cfg.assigneeMap` and persists immediately — so the project file stops
  carrying its own copy and a restart can't lose the mapping from both places. Folding
  never clobbers: a name already mapped centrally wins.
- `projectCfg(project)` / `ensureProjectCfg(project)` (creates a default config; runs
  `sanitizeValueMap` to drop legacy regex entries — entries lacking string
  `jira`/`target`). `clearProjectCfg`.
- `taskExt(task)` / `ensureTaskExt(task)`.

---

## 4. Value maps (`JiraModel.ts`)

`eq(a,b)` = case-insensitive trimmed equality.

### 4.1 Inbound — `mapInbound(entries, jiraValue, fallback)`

Return the `target` of the first entry with `eq(e.jira, jiraValue)`, else `fallback`.
(Many JIRA values → one target is allowed; first match wins.)

### 4.2 Outbound — `mapOutboundEntry(entries, targetId)` / `mapOutbound(...)`

`group` = entries with `e.jira` and `e.target === targetId`. `mapOutboundEntry` returns
the rule `group.find(outbound) ?? group[0]` (undefined if none); callers read `.id`
(preferred) with `.jira` (name) as the fallback. `mapOutbound(...)` = `mapOutboundEntry(...).jira`
(the name only), kept for the value-mapping tests.

### 4.3 Guessing (prefill)

`guessStatus({name, category}, statuses)`:

- `firstComplete` = first status with `complete`, else last, else `'done'`.
- `firstOpen` = first non-complete, else first, else `'todo'`.
- cat==='done' → firstComplete; name⊇'review' → `review`∥`in-progress`∥firstOpen;
  cat==='in progress' → `in-progress`∥firstOpen; else `todo`∥firstOpen.
  (`x∥y` = use id `x` if it exists in `statuses`, else `y`.)

`guessPriority(name, priorities)`: fallback `priorities[0] ?? 'medium'`;
`/highest|blocker|critical|urgent/`→critical, `/high|major/`→high,
`/low|minor|trivial/`→low, else medium — each mapped to that id if it exists, else
fallback.

### 4.4 Merge (prefill from discovered values)

`mergeStatusMap(existing, jiraStatuses[{name,category,id?}], statuses)`: start from
`existing`; for each `js`, if a rule for that name already exists **backfill its `id`**
when missing; otherwise push
`{ jira: js.name, target: guessStatus(js), outbound: <no outbound yet for that target>, id: js.id }`.
`mergePriorityMap(existing, jiraPriorities[{name,id?}], priorities)` is identical with
`guessPriority`. So a second load backfills ids onto legacy (id-less) rules.

### 4.5 Merge (adopt shared epic config) — `mergeEpicConfig(cfg, remote)`

For status & priority: for each remote rule whose **jira value** (ci) isn't already
present locally, append it (local rule wins → no conflicting duplicate). For
assignees: append each remote entry whose `name` isn't already present.

### 4.6 Validation — `validateValueMap(entries, kind, targets[{id,label}])`

Return human-readable errors; empty = valid:

1. any JIRA value in >1 rule → `Jira {kind} "{name}" appears in {n} rules — each Jira {kind} may map only once.`
2. any target with >1 outbound → `"{label}" has {n} rules flagged "→ Jira" — only one may write back.`
3. any target (from `targets`) with 0 outbound → `"{label}" has no rule flagged "→ Jira" — Obsidian can't write this {kind} back.`

`mapInbound`/`mapOutbound` remain deterministic even if invalid (first match / first
in group), so sync never crashes on an invalid map; the UI surfaces the errors.

### 4.7 JQL builders

- `projectKeyOf(key)` = substring before the last `-` (or the whole key).
- `epicChildrenJql(epic)` = `(parent = "{k}" OR "Epic Link" = "{k}") ORDER BY created ASC`, `k` = epic with `"` stripped.
- `parentInJql(keys)` = `parent in ("k1","k2",…) ORDER BY created ASC`.
- `keyInJql(keys)` = `key in ("k1","k2",…) ORDER BY created ASC` — fetch specific issues
  (e.g. the issues behind locally-dirty tasks whose JIRA side is unchanged).
- `subtreeChangedJql(trackedKeys, epic, since)` = the **incremental tick** query:
  `(key in (tracked) OR parent in (tracked, epic)) AND updated > "{toJqlTime(since)}" ORDER BY updated ASC`.
  The `key in` clause re-pulls tracked issues; the `parent in` clause catches **new
  children** of any tracked issue or the epic. With no tracked keys it degrades to
  `parent in (epic) …`; with no `since` the time filter is omitted. Subtree-scoped via the
  known local keys, so it never scans the whole project.
- `toJqlTime(iso)` = the JIRA ISO `updated` (`2026-04-20T10:00:00.000+0000`) collapsed to
  the `yyyy-MM-dd HH:mm` form JQL accepts.
- `epicUpdatedSinceJql` also exists (legacy single-epic incremental form); the current
  `runSync` uses a full crawl (manual) or `subtreeChangedJql` (periodic tick).

---

## 5. REST client (`JiraClient.ts`)

Constructed with `{ site, email, token, baseUrl? }`. `base = baseUrl ?? https://{site}/rest/api/3`.
Auth: `Basic base64(email:token)`.

### 5.1 `req(method, path, body?)`

- `requestUrl({ url: base+path, method, headers: { Authorization, Accept: json, X-Atlassian-Token, [Cookie], [Content-Type: json if body] }, body: JSON.stringify(body)?, throw: false })`.
- `ok = 200..299`. **Parse `res.text` defensively** (`parseJson`: empty/invalid → null);
  never read `res.json` (a getter that throws on empty `204`/`200` bodies).
- Returns `{ status, data: ok ? parseJson(res.text) : null }`.
- If API debug logging is on, `console.debug("[PM-JIRA] {method} {url} → {status}", {request, response})`.
  A non-2xx whose body isn't JSON also logs `rawBody` + response `headers` — an empty
  `response: null` otherwise hides the reason (proxy/WAF pages, plain-text refusals).

#### 5.1.1 XSRF and the transport fallback

Jira Cloud refuses writes it judges to be browser traffic with `403 "XSRF check failed"`
(plain text, plus a `atlassian.xsrf.token` cookie). Obsidian's `requestUrl` goes through
Electron's network stack, so a real site can classify our writes that way even with Basic
auth. Handling, in order:

1. Always send `X-Atlassian-Token: no-check` (covers Server/DC; Atlassian documents it as
   working for "command line tools or external systems, **not** browser requests").
2. Learn `atlassian.xsrf.token` from any response and echo it back as both the cookie and
   the header, then retry the refused call once.
3. If an **https** base still refuses, escalate that site to a direct **Node `https`**
   transport for the session — no cookie jar, no `Origin`, so the check never triggers —
   and retry. `requestUrl` stays the default for every other site; the localhost mock
   (plain http) only ever needs the retry.

Mobile has no Node, so a site that enforces this is read-only there.

### 5.2 Methods (exact paths)

- `testConnection()` → `GET /myself` (`ok`/user, or auth/HTTP error).
- `startFieldId(epicKey)`: probe **every** type from `GET /issue/createmeta/{proj}/issuetypes`,
  reading `GET …/issuetypes/{id}` for a field whose `name` (ci) === `"start date"` (accepting
  `fieldId` or `key`). Falls back to the instance-wide `GET /field` (custom-field ids are
  global). **Only a hit is cached** — a miss re-probes next sync rather than disabling
  start-date sync for the session. Warns when nothing matches.
- `projectStatuses(epicKey)` → `GET /project/{proj}/statuses` → unique `{name, category, id}`.
- `priorities(projectHint?)` → the project's **scheme** via createmeta `priority.allowedValues`
  (unioned over its issue types, cached per project); falls back to the instance-wide
  `GET /priority/search?maxResults=100`. A project rejects any priority outside its scheme
  (`400 "The priority selected is invalid"`), so mapping from the instance list is wrong.
- `myPermissions(projectKey, names)` → `GET /mypermissions?projectKey=…&permissions=…` →
  `{name: granted}`. Read-only probe behind the panel's **Check access**, for when writes
  fail but reads succeed.
- `issueTypes(projectHint?)` → `{name, level}[]` from the **project-scoped**
  `GET /issue/createmeta/{proj}/issuetypes` (`hierarchyLevel`; `subtask` ⇒ −1), cached per
  project. Falls back to `GET /issuetype` only when that yields nothing. The instance-wide
  list repeats type names across projects at **different levels**, so de-duplicating it by
  name mis-resolves the hierarchy (an Initiative read as level 0 makes its children
  Sub-tasks).

All of the createmeta readers accept whichever envelope Cloud returns — a paginated
`{values}`, a named collection (`{issueTypes}` / `{fields}`), or a bare array.
- `userPicker(query, max=10)` → `GET /user/picker?query=…&maxResults=…` → `{accountId, displayName}[]` (empty query → []).
- `search(jql, max=100)` (private): `GET /search/jql?jql=…&fields={list}&maxResults={max}[&nextPageToken=…]`;
  `fields` = `summary,status,priority,assignee,duedate,issuetype,parent,issuelinks,updated` plus the start field id when known; loop appending `nextPageToken` until `isLast || !nextPageToken`; normalize each issue.
  - `epicChildren(epic)`=search(epicChildrenJql); `subtasksOf(keys)`=search(parentInJql) (`[]` if no keys); `getIssue(key)`=`GET /issue/{key}?fields=*navigable`.
- `createIssue(fields)` → `POST /issue` body `{fields}` → `{key}` or `{error}`.
- `editIssue(key, fields)` → `PUT /issue/{key}` body `{fields}` → boolean ok.
- `getTransitions(key)` → `GET /issue/{key}/transitions` → `{id, name, to:{id, name}}[]`.
- `transitionTo(key, statusName, statusId?)`: find transition matching `to.id === statusId`
  (when given) **else** `to.name` (ci); `POST /issue/{key}/transitions {transition:{id}}`;
  false if none/!ok. (Callers pass the persisted status id so a rename/duplicate name doesn't misfire.)
- `getProperty(key, propKey)` → `GET …/properties/{propKey}` → `.value` or undefined.
- `setProperty(key, propKey, value)` → `PUT …/properties/{propKey}` body = value → ok.
- `createLink(blockedKey, blockerKey)` → `POST /issueLink {type:{name:'Blocks'}, inwardIssue:{key:blockedKey}, outwardIssue:{key:blockerKey}}` (blocked "is blocked by" blocker).
- `deleteLink(id)` → `DELETE /issueLink/{id}`.
- `setJiraApiDebug(on)` — module-level flag for §5.1 logging.

---

## 6. Issue normalization (`normalizeIssue(raw, startFieldId?, browseBase?)`)

Maps a raw JIRA issue → `JiraIssue`:

```
key, summary, status (fields.status.name), statusCategory,
priority (fields.priority.name), assigneeAccountId, assigneeName,
start = fields[startFieldId] (if id known), due = fields.duedate,
updated, parentKey = fields.parent.key,
issueType = fields.issuetype.name,
isSubtask = fields.issuetype.subtask === true || /sub-?task/i.test(name),
description = adfToMarkdown(fields.description, descriptionStash, issueUrl)  // §6.1
descriptionStash = { token → AdfNode }   // nodes Markdown can't hold, kept verbatim
blockedBy = keys of issuelinks where type.inward === 'is blocked by' (inwardIssue.key),
blockLinks = those links with their { id, key }
```

`issueUrl = browseBase && key ? `{browseBase}/{key}` : undefined` — the client passes its
`https://{site}/browse` base so attachment links can point at something openable (§6.1).

### 6.1 Description conversion (`adf.ts`)

Jira holds a description as **ADF** (Atlassian Document Format — a node tree), Obsidian
holds it as the note's Markdown body. One module converts both ways, and it is the only
place that knows the format:

- `adfToMarkdown(doc, stash?, issueUrl?)` → Markdown
- `markdownToAdf(md, stash?)` → an ADF `doc`

Covered both ways: paragraphs, headings, `strong`/`em`/`code`/`strike` marks, links,
bare URLs (autolinked), bullet and ordered lists, code blocks (with language), block
quotes, panels, rules, hard breaks, mentions, emoji, and **tables** (kept as tables, not
flattened).

**Placeholders.** Anything the conversion can't represent in Markdown becomes a
placeholder, and the placeholder is what puts the original node back on the way out:

- **Attachments** round-trip *statelessly*, through the link itself:
  `[Shot.png](https://site/browse/ENG-1#pm-media=<id>&c=<collection>&w=<width>&t=<type>&l=<layout>)`.
  Every attribute Jira needs is in the URL, so no side table is required, and the link
  opens the issue in a browser rather than dying on an unknown scheme. (An older
  `jira-media:` form is still read, and upgraded in place — see §8.2.)
- **Everything else** (an expand block, a macro) is stashed verbatim in
  `task.ext.jira.adfStash` under a `jira-node:<token>` link, and restored from there.

`unrestorablePlaceholders(md, stash)` names any placeholder that can no longer be put
back (its stash entry is gone, or its link was mangled by editing). Only that blocks a
push — see `unpushableDescription` in §8.2.

**Reading vs syncing.** `adfToMarkdown` with no `stash` is the *display* path: an unknown
node's children are rendered, so the reader sees the words. With a `stash` it is the
*sync* path: the node is kept whole behind a placeholder, so pushing restores it exactly.

**Canonical comparison.** The conversion is not the identity function (`- a` may come home
as `* a`), so `fieldsEqual(a, b, 'description')` also compares
`canonicalDescription(md) = adfToMarkdown(markdownToAdf(md))`. Without this, every push
would make the next sync read its own lossy round trip as a remote edit and rewrite the
note.

---

## 7. Local server (`JiraMock.ts`, `JiraMockServer.ts`)

A faithful, hand-editable JIRA stand-in so all paths are tested without a real
instance. **Implementation detail; not user-facing.**

### 7.1 Server

- `node:http` server bound to `127.0.0.1`, OS-assigned port (`listen(0)`). Loaded
  via `window.require('node:http')` (desktop) with a dynamic-import fallback; null on
  mobile (server simply doesn't start).
- Started only when a configured server's site matches `localhost`/`127.0.0.1`,
  via `ensureMockServer` (idempotent singleton). `stopMockServer` tears it down.
- `handle()`: reject non-loopback callers (403); parse path (strip `/rest/api/3`),
  read body, `loadStore()`, `route()`, `saveStore()` if mutated, `send()`.
- `mockBaseUrl(site)` returns `http://127.0.0.1:{port}/rest/api/3` when running and
  the site is localhost; the client uses it as `baseUrl`.

### 7.2 Routes (faithful to §5.2)

`/myself`, `/search/jql` (token paging: `nextPageToken` = numeric offset, `isLast`),
`/search` (legacy offset paging, kept for completeness), `/priority`,
`/priority/search`, `/user/picker`, `/project/{k}/statuses`,
`/issue/createmeta/{k}/issuetypes(/{id})` (the second returns `summary` required,
`priority` with allowedValues, `duedate`, and the Start-date custom field),
`/issue/{key}/transitions` (GET list / POST apply), `/issue/{key}/properties/{p}`
(GET/PUT), `POST /issueLink`, `DELETE /issueLink/{id}`, `POST /issue`,
`GET`/`PUT /issue/{key}`.

JQL matching (`matchJql`): supports `parent = "X"`, `parent in (…)`, and
`updated > "X"`; sorts by `updated` asc.

### 7.3 Data store (`JiraMockStore`)

- `MockDb = { project, meta, issues }`; issues in native `{id, key, fields, properties?}`.
- `meta = { startFieldId, statuses[], priorities[], users[], seq, linkSeq? }`.
- `createIssue(fields)` mints `{project}-{++seq}`, sets initial status (first/“To Do”),
  `normalizeFields` (resolves priority/assignee, stamps `issuetype.subtask` from the
  name), `updated = now`.
- `ensureIssue(key, fields)` inserts with an explicit key if absent (used for the epic).
- `editIssue`, `transitionsFor`/`applyTransition` (every status reachable; no workflow
  restrictions), `getProperty`/`setProperty`, `addBlockLink`/`removeLink` (links carry
  ids; both linked issues get `updated` bumped).

### 7.4 Seeding & lifecycle

- `seedMeta(store, inputs)` populates statuses (name = settings label;
  `statusCategory` from `complete`), priorities (label), users
  (`globalTeamMembers ∪ project.teamMembers`, accountId = `mock:{slug(name)}`).
- On first `ready()`, `seedMockFile` seeds meta once and `ensureIssue`s the epic as a
  real issue (`summary = project.title`, `issuetype: Epic`).
- Persisted as `jira-mock.json` in the plugin data dir; reloaded per request so hand
  edits apply. Removing the last localhost server stops the server and **deletes the
  file** (`deleteMock`).

---

## 8. Sync engine (`sync.ts`)

### 8.1 Helpers

- `projectKey(cfg)` = `projectKeyOf(epicId)` or `"MOCK"`.
- `makeClient(plugin, project)`: requires `cfg.enabled` and a server with a site;
  `baseUrl = mockBaseUrl(site)`; requires a token unless `baseUrl` (localhost). Returns
  a `JiraClient` or null.
- `ready(plugin, project)` = `ensureMockServer` + `seedMockFile` + `makeClient`.
- `shadowOf(task, keyOf?, parentKey?)` = the `JiraShadow` fields from the task;
  `blockedBy` = `desiredBlockerKeys(task, keyOf)` when a key map is given, else `[]`;
  `parent` = `parentKey` (callers pass what the task's position implies, `''` when there
  is nothing to compare against).
- `localParentKey(project, taskId)` = the JIRA key a task's position in the local tree
  implies: its parent task's key, or the mapped root's for a top-level task; `''` when the
  parent exists locally but isn't synced. Used wherever `mine` is built outside `runSync`
  (the merge editor, `resolveConflict`).
- `assigneeField(task, cfg)`: no assignee → `null` (unassign); mapped → `{accountId}`;
  assignee present but unmapped → `undefined` (omit — don't clobber).
- `withJiraKey(task, key, keyOf, cfg, startField, plugin, parentKey)` links a just-created
  task: `ext.jira = {key, sync:true, shadow}`. The shadow records **what was actually
  pushed**, including the parent the issue was created under (with a blank parent baseline
  a later reparent has neither side matching the base, and a plain move reads as a
  conflict) — and when
  `assigneeField(task,cfg) === undefined` (unmapped) the assignee wasn't sent, so
  `shadow.assignees = []` (not the local name), and with no `startField` the date wasn't
  sent either, so `shadow.start = ''`. Otherwise the next reconcile would read Jira's empty
  value as a remote deletion and drop the local one; instead the field stays "to push" and
  surfaces as a conflict until the mapping/field exists.
- `priorityRef(entry)` = `entry.id ? {id} : {name: entry.jira}` — prefer the persisted
  priority id, fall back to the name.
- `createFields(task, parentKey, typeName, cfg, startField)`:
  `{ project:{key}, issuetype:{name: typeName}, summary, parent:{key: parentKey} }`;
  `+ duedate (if due), + [startField]=start (if both), + priority: priorityRef(mapOutboundEntry(priority)) (if any), + assignee (if assigneeField !== undefined)`.
- `pushNewIssue(...)`: `createIssue(createFields)`; on no key, log + return null; then
  `transitionTo(status.jira, status.id)` where `status = mapOutboundEntry(statusMap, …)` (if any);
  `setProperty(ISSUE_PROP, {milestone})`; return key.

### 8.2 `runSync(plugin, project, opts?: { full?: boolean }) → SyncResult`

`SyncResult = { changed, jiraCreated, jiraUpdated, obsidianUpdated, membersAdded,
conflicts, archived, skippedTooDeep, skippedNoParent, newIssues }`. Requires
`cfg.enabled` and `cfg.epicId`.

**Full vs incremental.** `opts.full` defaults to `true`. A **full** sync (manual
`syncNow`, the import bootstrap) pulls the shared epic config and crawls the whole epic
subtree. An **incremental** sync (`full:false`, the periodic `syncTick`) skips the
epic-config pull and pulls only `subtreeChangedJql(trackedKeys, epic, watermark)` plus
the issues behind locally-dirty tasks — so an idle tick fetches nothing and a busy one
costs O(changes) requests, never O(tree) + type/config metadata every minute. The epic
config has no `updated` watermark (entity-property writes don't bump it), so it can't be
polled incrementally; ticks rely on the last full sync having adopted it.

Steps, in order:

0. `full = opts.full !== false`; `startField = client.startFieldId(epicId)`;
   `fallback = settings.statuses[0].id ?? 'todo'`.
1. **(full only)** `pullEpicConfig`: `getProperty(epic, CONFIG_PROP)`; if present →
   `mergeEpicConfig`; else if local maps exist → set `mappingsDirty` (bootstrap publish later).
2. Index local tasks (by id, by key, parentOf, `keyOf`). Then **hydrate the bodies** of
   every linked, synced task (`store.loadTaskBody`): note bodies load lazily, and an
   unread body reads as `''` — which, now that the description is a synced field, would
   look like "the user cleared it" and push an empty description over Jira's.
3. **Create** opted-in keyless tasks (parent-first, both modes): for each flat task with
   no `key`, `sync === true` and **not archived**, lazily `buildTypePlan` (so a no-create
   tick fetches no type metadata), resolve the child type via `childTypeFor` (skip +
   `skippedTooDeep` when nested below the lowest type; skip + `skippedNoParent` when the
   task's own parent isn't synced yet — never re-root onto the epic, which would create it
   a level too high), `pushNewIssue` with the parent's key; record key; patch the task
   `ext` with `{key, sync:true, shadow}`. Then `reconcileLinks` per created task.
4. **Fetch the JIRA side** then **reconcile** every linked & synced task with a single
   **3-way merge** against its issue (see 8.3).
   - **full**: `all = epicDescendants(epic)` (BFS crawl, O(depth) `parent in` queries).
   - **incremental**: `all = changedInSubtree(trackedKeys, epic, watermark)`; for any
     locally-dirty tracked key (shadow diverged or `reconciled === false`) not already in
     that result, also `issuesByKeys(missing)` so a local-only edit still pushes.
   Index by key; track `maxUpdated`. Issues in `all` that are not a local task, not created
   this run, and not in `ignoredKeys` → `newIssues`. Then for each flat task with `sync`
   and `key`:
   - **Archived tasks are out of the active set** — no reads, no writes, no creates,
     whoever archived them. The one exception: a task *we* archived for leaving the root's
     subtree (`outOfScope`) whose issue is back in a **full** crawl is un-archived and the
     marker cleared. A hand-archived task has no marker and stays put (§8.8).
   - **Issue absent from `all`**: on a **full** sync the crawl covered the whole subtree, so
     absence means the issue left the mapped root (moved to another project, or deleted) →
     archive the task (§8.8). On an **incremental** tick absence only means "unchanged
     since the watermark", so the task is skipped untouched.
   - `desiredParent = keyOf(parentOf(task)) ?? epicId`;
     `mine = shadowOf(task, keyOf, desiredParent ?? '')`;
     `localDiverged = !ext.shadow || mine ≠ ext.shadow`. Skip (no HTTP) when
     `!localDiverged && issue.updated ≤ prevWatermark && ext.reconciled !== false`.
   - **Stale attachment links**: when `mine.description` differs from Jira's *only* by
     carrying the old `jira-media:` form (canonically the same document), take Jira's
     rendering. Both forms rebuild the same ADF, so the merge rightly sees no change and
     would never rewrite the note — this upgrades the link without pushing anything.
   - `theirs` from the issue (`resolveAssignee` may auto-create a mapped member);
     `blockedBy = issue.blockedBy`; `description = issue.description`;
     `parent = issue.parentKey ?? epicId` (every issue here came from inside the root's
     subtree, so a missing `parent` means it hangs off the root by the legacy "Epic Link",
     not that it has no parent). `base = ext.shadow ?? theirs`, and a legacy shadow with no
     `parent` baseline reads as `mine.parent` — "we didn't move it" — so a Jira-side move
     that the old one-way code reverted every cycle lands instead of being reverted once more.
   - **Resolve an inbound parent move** (before any write, since an out-of-scope issue is
     not ours to write to): if `parent` is in `tw.adopt`, its target is either a task here
     (queue a local move), the root itself (queue a move to top level), still inside the
     root's tree but not imported here (nothing to move to → *held*), or outside the tree
     entirely (→ archive the task and skip it). "Outside" is proven, not assumed: the new
     parent's ancestry is walked up with `underRoot` (§8.8).
   - `tw = threeWay(mine, base, theirs)` (8.3). If `tw.conflicts` non-empty →
     `flagConflict(task, theirs)` (`reconciled:false`, `conflict:{theirs}`), keep local,
     `conflicts++`, continue. **The shadow is NOT advanced**, so the next sync re-examines it.
   - **Push** `tw.push` fields: `summary`/`duedate`/`[startField]`/`priority`/
     `description` (as `markdownToAdf(body, adfStash)`) / `parent` (with `issuetype` when
     the move crosses a level — §8.8) via `editIssue` (`priority` =
     `priorityRef(mapOutboundEntry)` → id or name); `status` via
     `transitionTo(status.jira, status.id)` from `mapOutboundEntry`; `milestone` via
     `setProperty(ISSUE_PROP)`; `blockedBy` via `reconcileLinks(key, issue.blockLinks,
     desiredBlockerKeys)`. A `priority`/`status` with no canonical outbound, an
     `assignee` whose local member has no JIRA-user mapping (`assigneeField === undefined`),
     a `start` with **no discovered start field**, or any rejected write is *held*: named in
     a `held[]` reason list, logged as `[PM] Jira: {key} held back — {reasons}`, and treated
     as a failure. These are surfaced, never silently dropped — a held field that left
     `fields` empty would skip the edit entirely and still advance the shadow, losing the
     change (how start dates vanished live).
     A **description** is also held rather than written when `unpushableDescription` says
     so: an `unrestorablePlaceholders` hit (pushing the placeholder text would replace a
     real attachment in Jira with the words describing it — the file would be gone from
     the issue), or a locally empty description where Jira has one (far more often a body
     we failed to read than a deliberate deletion, and being wrong costs someone else's
     writing). An inbound parent move with nowhere to land is held the same way.
     If held/`!ok` → `flagConflict(task, theirs)`, `conflicts++`, continue (no shadow advance).
     Else `jiraUpdated++` if `tw.push` non-empty.
   - **Adopt** `tw.adopt` fields into a task patch (`status`/`priority`/`title`/`start`/
     `due`/`assignees`/`type`/`description` — which rewrites the note body, so
     `applyExternalUpdates` picks the full write; `blockedBy` → `dependencies` via key→id;
     `parent` → the queued move). `obsidianUpdated++` if `tw.adopt` non-empty.
   - Advance the shadow to the **merged baseline** (adopted fields take JIRA's value, the
     rest stay local) and clear `reconciled`/`conflict`. When the description was adopted,
     the issue's `descriptionStash` is stored with it, so its placeholders stay restorable.
5. `cfg.dirtyQueue = []`; `lastSeenUpdated = maxUpdated`; `lastSyncAt = now`.
6. `pushEpicConfig`: if `mappingsDirty`, `setProperty(epic, CONFIG_PROP, {maps})`,
   clear the flag.
7. `applyExternalUpdates(project, patches)` (store-level, persists), **then** the queued
   parent moves via `store.moveTask` — a move rewrites the moved task's file and both
   parents' bodies, so it must not race the field writes for the same notes.

The dirty queue is now only a hint for `syncTick` (which tasks to look at first); the
3-way merge is what decides push/adopt/conflict, so a rejected push isn't "lost" —
the shadow stays behind and the next sync retries.

### 8.3 `threeWay(mine, base, theirs)` (`reconcile.ts`)

The single reconcile primitive, applied per field over `SYNC_FIELDS` (all ten
`JiraShadow` keys: title, status, priority, start, due, assignees, milestone,
description, parent, blockedBy). `fieldsEqual` compares scalars by `===`, arrays
(`assignees`, `blockedBy`) as unordered sets, and `description` by canonical form as
well (§6.1) so a lossy round trip isn't read as someone's edit.

| condition (per field)          | classification                  |
| ------------------------------ | ------------------------------- |
| `mine == theirs`               | already agree — nothing to do   |
| `mine == base` (we didn't touch it) | **adopt** JIRA's value     |
| `theirs == base` (they didn't) | **push** our value              |
| otherwise (both changed)       | **conflict** `{field, mine, theirs}` |

Returns `{ push: SyncField[], adopt: SyncField[], conflicts: FieldConflict[] }`.

### 8.3a `resolveConflict(plugin, project, task, takeTheirs: SyncField[])`

User-driven conflict resolution. For each field in `takeTheirs`, apply JIRA's captured
value (`ext.conflict.theirs`) to the task (`blockedBy` → `dependencies` via key→id;
`description` writes the note body); every other field keeps its local value. Reset
`shadow = theirs` (the new baseline) and clear `reconciled`/`conflict`. Persist via
`applyExternalUpdates`. Because the baseline is now JIRA's snapshot, kept-local fields
differ from it and the next sync **pushes** them, while taken fields already match and
stay put.

Two fields need more than a value write:

- `description` — missing this was a live data-loss bug: taking Jira's description
  changed nothing locally while the shadow moved to Jira's value, so the next sync read
  the untouched local text as a fresh edit and pushed it back over Jira's.
- `parent` — a structural change, applied with `store.moveTask` after the patch. When
  the target isn't a task here the move can't be made, so the baseline keeps **our**
  parent; otherwise the next sync would read our unchanged position as a local edit and
  push our hierarchy back over Jira's, quietly undoing the move just accepted.

### 8.4 `reconcileLinks(client, blockedKey, currentLinks, desired)`

For each `k` in `desired` not in `current` → `createLink(blockedKey, k)`. For each
`l` in `current` not in `desired` → `deleteLink(l.id)`. Returns true iff all succeeded.
`desiredBlockerKeys(task, keyOf)` = `task.dependencies` mapped to keys that exist.

### 8.5 `resolveAssignee(project, issue)`

Find a mapping by `jiraUser === assigneeAccountId || assigneeName` in the server's
**shared** list (`sharedAssignees`, §3.6). `name = found?.name ?? assigneeName ??
assigneeAccountId`. If not found, push a new mapping `{name, jiraUser, jiraDisplay}` (to
the shared list — the mapping is a property of the site, so every project on it learns
the person at once). **Always** ensure `name` is in `project.teamMembers` — but only for
the project the task is in: a person Jira introduces joins a project **on demand**, when
a task there names them, not by being pushed into every linked project's member list.
Return name (or null when the issue has no assignee).

### 8.6 `syncTick` / interval gate

`dueForSync(cfg, now)` = `now - (lastSyncAt?Date.parse:0) >= (syncIntervalMin ?? 5)*60000`.
`onTaskChanged` → `queueDirty(cfg, task)`: only when `cfg.enabled` and
`taskExt(task).sync`; append the id if absent.

`JiraConnector.syncTick` runs an **incremental** `runSync(plugin, project, {full:false})`
when due; `syncNow` always runs a **full** sync. The plugin's 60 s `connectorTick`
(`main.ts`) is the driver: it **pauses while Obsidian is hidden/minimized**
(`activeDocument.hidden` → early return, resumes on the next tick once visible), then for
each loaded project calls each connector's `syncTick`. So nothing polls JIRA while the app
isn't on screen.

### 8.7 Deletes (`onTaskDeleted` → `ignoreOnDelete`)

Deleting a task in Obsidian **never deletes the JIRA issue**. `ProjectStore.deleteTask`/
`deleteTasks` fire the `onTaskDeleted` connector hook once per removed task **and each of
its descendants** (pre-order, before the subtree leaves the tree), then persist the
project. `JiraConnector.onTaskDeleted` → `ignoreOnDelete(cfg, task)`: if the task had a
`key`, add it to `ignoredKeys`. So the next sync leaves the issue alone and, crucially,
does **not** re-offer it as a `newIssue` (the bounce-back a plain tree removal would cause).
Inbound is intentionally asymmetric: a JIRA issue that disappears never deletes local
data. A **full** sync archives the task instead (§8.8) — it leaves the active set but
keeps its key, its note, and its history; an incremental tick leaves it alone entirely,
since absence there only means "unchanged".

### 8.8 Hierarchy: parent, issue types, and leaving the root's scope

**Type plan.** `buildTypePlan(client, cfg)` reads the project's issue types with their
`hierarchyLevel` (`subtask ⇒ −1`) and the root issue's own type, giving `levelOf(name)`,
`rootLevel`, and `levelByKey` (keys discovered as issues are seen). `typeForLevel(level)`
picks the preferred type for a level — Task before Story before Bug before Epic before
Sub-task — so a *new* issue gets the conventional type. `childTypeFor(client, plan,
parentKey)` = exactly one level below the parent's, resolving the parent's level from
`levelByKey` or by fetching it; `null` when that would fall below the lowest type
(→ `skippedTooDeep`).

**Depth decides the type.** A move across levels is therefore a type change too, and
Jira validates `parent` against the issue's *current* type — so "become a Task and take
this Epic as parent" is rejected outright, and changing only the type doesn't help either
(the parent it still has is now the wrong level). `pushEdit` walks it through legal
intermediate states instead: detach (`parent: null`) → convert (`issuetype`) → re-attach.
A partly-applied walk is safe: the next sync still sees the parent diverged and finishes.

**A same-level move must not retype the issue.** The comparison is on hierarchy *levels*,
not type names: `typeForLevel` returns the level's *preferred* type, so matching on the
name would rewrite a **Bug** into a Task on any reparent — losing the type, its workflow
and its fields — even when the level was already right.

**Parent is a merged field.** It is one of `SYNC_FIELDS` (held as a JIRA key, §3.4), so a
move made in Jira is adopted rather than reverted, a move made here is pushed, and a move
made on both sides is a conflict the resolver shows like any other field.

**Leaving the root's scope → archive.** A parent moved *outside* the mapped root's subtree
can't be represented locally at all — the issue simply isn't in the tree this project
syncs. The task is **archived**: it leaves the active set (§8.2 step 4) while keeping its
JIRA key, which is what stops it being mistaken for a new local task and recreated in Jira
as a duplicate. `ext.jira.outOfScope` marks the archive as ours, so the task comes back if
the issue returns under the root; a hand-archived task has no marker and stays archived.

Two routes reach it, and they differ in what counts as evidence:

| signal | when it fires | why |
| --- | --- | --- |
| the issue's new parent is outside the tree — `underRoot(client, key, rootKey)` walks the parent chain up (≤8 hops; an unreadable issue counts as outside) | full **and** incremental | positive evidence: the issue was fetched and names a parent we can prove isn't under the root, so a periodic tick can act on it |
| the issue is absent from the fetched set | **full only** | a full sync crawls the whole subtree, so absence means it's gone (moved project, or deleted). On a tick absence just means "unchanged since the watermark" — acting on it would archive the entire project |

`SyncResult.archived` counts them, and the manual-sync notice reports the line.

---

## 9. Import / Export / linking

### 9.1 Opt-in linking (`taskLink.ts`)

- `defaultNewTaskSync(task, isNew)`: a new task with no key and `sync === undefined`
  gets `sync = true`.
- `isLinkChecked(task, isNew)` = `isNew || !!key || sync === true`.
- `linkTask` sets `sync = true`. `unlinkTask` removes `ext.jira` and adds the key (if
  any) to `ignoredKeys`.
- `stripJira(ext)` removes the whole `jira` block (Disconnect). A conflict is cleared
  through `resolveConflict` (8.3a), not a standalone helper.

### 9.2 Import (`importStories`, `fetchEpicStories`)

`fetchEpicStories` = `ready` + `startFieldId` + `epicChildren`. `importStories(plugin,
project, stories)`: `pullEpicConfig`; `startFieldId`; `picked` = stories not already
imported (by key); `subs` = `subtasksOf(picked keys)` not already imported; build a
task per issue via `issueToTask` (resolves+creates assignees, sets type/status/
priority/start/due, `ext.jira = {key, sync:true, shadow}`); wire `dependencies` from
`blockedBy` via the key→id map; nest subtasks under their parent (`isSubtask &&
parentKey`); advance `lastSeenUpdated`; `store.importTasks` (persists). Returns
`{created}`. Duplicate-title tasks get unique `<slug>-<id8>` file names.

### 9.3 Export (`exportTasks`, `exportableTasks`)

`exportableTasks` = flattened tasks with no key. `exportTasks(plugin, project,
taskIds)`: `pullEpicConfig`; `startFieldId`; for each selected keyless task,
parent-first, `pushNewIssue` and patch `ext = {key, sync:true, shadow}`; then
`reconcileLinks(key, [], desiredBlockerKeys)` for created ones; `pushEpicConfig`;
`applyExternalUpdates`. Returns `{created}`.

### 9.4 `loadMappingValues` ("Load project settings")

`pullEpicConfig`; `mergeStatusMap`/`mergePriorityMap` from `projectStatuses`/`priorities`;
mark dirty if maps grew; `store.saveProject` (persist immediately). Returns
`{statusesAdded, prioritiesAdded}`.

---

## 10. UI

### 10.1 Global settings (`renderJiraGlobalSettings`)

Server cards (name/site/email/token, **Test connection**, **Remove**), **+ add
server**, and a **Debug log Jira API calls** toggle (writes `setDebug` +
`setJiraApiDebug`). Removing the last localhost server stops the local server and
deletes its data file (notice).

### 10.2 Project panel (`renderJiraProjectPanel`)

Enable toggle; server select; **Epic key**; **Load project settings** (§9.4);
status & priority map editors — each row = JIRA value input + target select +
exclusive "→ Jira" outbound checkbox + delete + "add rule"; inline validation
(`validateValueMap`) with messages + red-outlined offending rows; assignee map (one
row per team member with a JIRA user-picker autocomplete); sync interval; and the
**Jira import / Jira export / Check access / Clean Jira / Disconnect** actions. Editing a
map sets `mappingsDirty`. Load/import/export re-render the **whole** modal (via the host
`onChange`) so newly created team members appear.

Changing the **Epic key** clears `lastSeenUpdated`: a different root is a different
subtree, and the old watermark would hide every issue there that hasn't changed since.

- **Check access** (§5.2 `myPermissions`) — read-only; reports the authenticated account
  and which sync permissions it holds on the mapped project. Creates nothing.
- **Clean Jira** — deletes the per-issue `obsidian-pm` property from every linked issue and
  `obsidian-pm-config` from the epic, then (only if the remote wipe fully succeeded)
  clears the local config and strips each task's `jira` block, for a clean reset. Issues
  are never deleted. On any failure it stays connected so the wipe can be retried
  (deletes are idempotent).

### 10.3 Task field (`renderTaskField`)

A "Jira" row: a sync checkbox (state = `isLinkChecked`; check → `linkTask`, uncheck →
`unlinkTask`) and, when linked, the issue-key link. When `reconciled === false`, an
"Out of sync" row with a **Resolve…** button that opens the merge editor (10.4) focused
on that task.

### 10.4 Merge-conflict editor (`JiraMergeModal`)

A wide, two-pane 3-way merge editor (like vscode/meld), opened by `syncNow` whenever
`hasConflicts(project)` after a manual sync (conflicts take priority over the import
dialog), and by the per-task **Resolve…** button (with that task pre-selected).

- **Left sidebar**: every conflicted task (`reconciled === false` with a stored
  `conflict`), showing title, issue key, and the count of fields needing a decision.
- **Detail pane**: `conflictFields(mine, base, theirs)` is split by `defaultTakeTheirs`
  (which is `mine == base`):
  - **decisions** (`mine != base`) — fields WE changed that still differ from Jira (a
    genuine conflict, or a push Jira rejected). Only these are shown, one row with three
    columns: **Obsidian** (`mine = shadowOf(task, keyOf)`), **Base** (`ext.shadow`,
    read-only common ancestor), **Jira** (`ext.conflict.theirs`). Obsidian/Jira cells are
    selectable (default: keep Obsidian, since we changed it); base is reference only.
    **Use all Obsidian** / **Use all Jira** flip every decision.
  - **auto-merge** (`mine == base`, only Jira changed) — adopted automatically, never a
    decision; listed in an "Also merging from Jira: …" note so the merge isn't a black box.
- **Compare…** on a long value (a description) opens `JiraTextCompareModal`: the two
  sides full-height and side by side, raw text by default, with a **Show preview** toggle
  that renders each side as Markdown (`MarkdownRenderer` against the task's own path, so
  links and embeds resolve as they would in the note). One line of a description is
  almost never enough to decide with.
- **Resolve & next** calls `resolveConflict(task, takeTheirs)` (8.3a) with
  `autoTheirs ∪ {decisions whose Jira cell is selected}`, then rescans and advances; the
  editor closes once the list is empty. (A flagged task whose fields now all agree is a
  stale flag — skipped here, self-healed on the next sync.) Values render with their
  labels via `conflictFormat.ts`, shared with the diff logic.

### 10.5 Toolbar

A Sync icon button (`refresh-cw`, matching the settings gear) shown only for
connectors that are `isEnabled` and expose `syncNow`; click runs `syncNow`. A
command "Jira: sync active project now" does the same.

---

## 11. Persistence & auto-save

- The project settings modal has **no Save button**. Existing projects auto-persist
  on close _iff_ something changed and the title is non-empty (snapshot compare). New
  projects use an explicit **Create project** action; dismissing doesn't create one.
- Import, Export, and Load project settings persist immediately.
- The store writes the project note on every save (so `teamMembers`/config persist
  even with no task changes). New-task file names are disambiguated on collision.

---

## 12. Guarantees & limitations

**Guaranteed (tested):** per-field 3-way merge over the common shadow (disjoint changes
auto-merge, both-sided changes surface as a conflict — no clobber); a rejected push
keeps the shadow behind and surfaces a conflict (no silent drop); conflicts resolve
field-by-field (keep mine re-pushes, take theirs adopts); two-way create/edit/status/
assignee/unassign/dependencies/milestone/dates/hierarchy/**description**; a reparent in
either direction (adopted, pushed with the type change a level move needs, or surfaced as
a conflict) and an out-of-scope move archived rather than duplicated; an issue's type is
never rewritten by a same-level move; descriptions round-trip through ADF with
attachments and unknown nodes restored as the nodes they were, and are never pushed as
placeholder text; map validation; merges never duplicate a JIRA value; all I/O over HTTP.

**Validated against a real Jira Cloud instance:** an end-to-end outbound write —
create under an Epic parent, summary, status transition, due date, **start date**,
priority, assignee, and the `obsidian-pm` property — plus the multi-level `parent`
hierarchy, both the full `(parent OR "Epic Link")` and incremental `subtreeChangedJql`
queries, createmeta start-field discovery, issue-type level resolution, the
`Blocks`/"is blocked by" link type, and screenless/global status transitions across all
issue types. All instance-specific ids and names are discovered at runtime — none are
hardcoded.

**Learned the hard way (each shipped as a live bug, now covered):** writes are refused as
XSRF through `requestUrl` (§5.1.1); a project accepts only its **priority scheme**, not
the instance's priorities; the "Start date" field may be absent, on a later issue type,
or reported in a different envelope; the instance-wide `/issuetype` list repeats names at
different hierarchy levels. Every one passed the suite beforehand because the mock had
been written to match the connector's assumptions — it now models these shapes
(§13), and each fix was verified by reverting it and watching its test fail.

**Residual (still unproven without a real instance):** company- vs team-managed
`parent`/"Epic Link" on other project styles; rate-limits (failures surface as conflict,
no backoff); nesting below the lowest issue type (skipped + flagged); inbound reconcile
and conflict resolution against a real instance (proven on the mock only).

**Descriptions, specifically.** The ADF converter has been exercised against real issue
descriptions only in small numbers; every defect found so far came from real data, not
from the synthetic tests (a bare URL arriving as dead text, an attachment link that
opened nothing, a placeholder pushed as literal text). Node types outside the list in
§6.1 survive the round trip via the stash rather than being converted, so they are safe
but not *editable* here.

**Known gap (not yet closed).** `serializeTask` appends generated body lines (a
`Parent: [[…]]` backlink, a `## Subtasks` list) and `stripAutoGeneratedContent` removes
them again with exact-line patterns. Now that the body is pushed to Jira, a miss escapes
into the issue, and the `## Subtasks` rule truncates whatever follows a heading a user
wrote themselves. The fix is either fencing the generated block in `%% pm:auto %%`
comments or moving the backlinks into frontmatter properties; neither is implemented.

---

## 13. Testing

- **Unit**: `JiraModel`, `JiraMock`, `taskLink`, value-map validation, and `adf.test.ts`
  (ADF ⇄ Markdown both ways, including tables, autolinks, and every placeholder form
  round-tripping to the node it came from).
- **HTTP integration**: real `JiraClient` ↔ local server (`JiraMockServer.test`).
- **End-to-end** (`sync.test`): a fake plugin/store over an in-memory vault drives
  `runSync`/import/export against the live local server over HTTP, including a second
  `JiraClient` acting as a teammate working solely in JIRA.
- **Coverage report**: `scripts/coverage-report.mjs` (under the connector) derives the
  report from the test files — one area per `describe`, one row per `it` →
  `docs/coverage.html` (interaction matrix + confidence score + residual-risk audit).
- **Scenario suites**: `parent.test.ts` (hierarchy both ways: created parent-first, held
  when the parent isn't synced, pushed reparents with/without a type change, a Bug kept a
  Bug, adopted Jira-side moves, both-sided move conflicts, and each route into the
  out-of-scope archive incl. the full-vs-incremental distinction); `assignee.test.ts`
  (mappings, renames across projects, on-demand membership); `incremental.test.ts`;
  `two-project.test.ts` (two Obsidian users on one epic).
- **Every fix is verified by reverting it**: a new test is run against the disabled fix and
  must fail. Several tests were rewritten after passing that way — the check is what
  caught them being vacuous.
- **Drift guards**: the test `FakeStore` is `implements Pick<ProjectStore, …>` (signature
  drift fails the build), and `integration.test.ts` drives the connector through the
  **real `ProjectStore`** over the in-memory vault (behavioral drift fails a test).
- **Instance shapes** (`instance-shape.test.ts`): the mock can be *wrong the way a real
  site is*, because a mock that only mirrors our assumptions validates our bugs. Knobs:
  `setPriorityScheme` (createmeta reports a subset; create/edit return the real
  `400 "The priority selected is invalid"`), `setStartFieldId('')` (a project with no
  Start date field), `setEnvelope('named')` (createmeta as `issueTypes`/`fields` instead
  of `values`), `armXsrfFailure()` (one write refused with a non-JSON `403 "XSRF check
  failed"` + token cookie), and `FOREIGN_ISSUE_TYPES` — foreign types sharing our names at
  the wrong hierarchy levels, permanently seeded into the instance-wide `/issuetype` so
  the hierarchy tests fail if type resolution ever reads from there again.

---

## Implementation history

1. **Model + persistence** — optional model & `ext` persistence; read-only client +
   pure model + dry-run writer; settings/import/sync (dry-run).
2. **Connector abstraction** — generic connector + `ext`; JIRA self-contained; lazy
   descriptor registry.
3. **Mapping UX** — prefill from live fetch; namespaced `ext` w/ migration; assignee
   picker; string-match maps (N→1, canonical outbound).
4. **Writes via the local server** — entity-property reconciliation; obsidian-free
   sync core; in-process HTTP server; localhost gating; create-issue workflow; store
   mints keys; start-date mapping; auto-seed on connect; all I/O over HTTP.
5. **Robust two-way + safety** — local reconcile, minimal writes, shared epic config;
   defensive JSON/export/epic-issue/two-way links; two-way assignee; field-level
   shadow diff; never drop a rejected push; migrate to `/search/jql`.
6. **Validation & UX** — map validation (one rule per JIRA value, ≥1/≤1 write-back per
   target); duplicate-mapping fix; import/export in the panel; toolbar Sync icon;
   Load project settings adopts config + creates members; modal re-render after Load/
   import; client-side `console.debug` API logging; auto-persist (Save removed);
   delete the local data file on last-server removal.
7. **Testing & docs** — HTTP integration suite; teammate scenarios; filename-collision
   & team-member fixes; coverage report; this spec.
8. **Per-field 3-way reconcile** — replaced the status-only reconcile with `threeWay`
   over the full shadow (closing the gap where non-status fields were silent
   last-writer-wins); folded dependencies into the merge via `blockedBy`; capture
   JIRA's snapshot on conflict and resolve field-by-field (`resolveConflict`);
   reassessed the confidence score.
9. **Merge-conflict editor** — a wide, two-pane `JiraMergeModal` (sidebar of conflicted
   tasks + 3-way Obsidian|base|Jira diff) that opens after a manual sync when conflicts
   exist; supersedes the per-task `JiraConflictModal`.
10. **Incremental sync** — split `runSync` into full (manual/import) vs incremental
    (periodic tick): subtree+watermark query plus a key-in fetch for dirty issues, no
    epic-config/type-metadata per tick; polling pauses while Obsidian is hidden.
11. **Persisted Jira ids** — `JiraValueMap.id` (priority/status id) discovered at
    mapping-load and used on outbound writes (`priorityRef` → `{id}`; `transitionTo`
    matches `to.id`), backfilled onto legacy rules; team-member ids already covered by
    `assigneeMap.jiraUser`.
12. **Real-instance hardening** — the XSRF transport fallback, priority *scheme* per
    project, Start-date discovery across envelopes, per-project issue-type levels, a
    live sync-progress popup, and a "Check access" report of what the token may actually
    do. Each shipped as a live bug first; the local server now models the shape that
    caused it.
13. **Assignee mappings centralized** — moved from each project to one list per
    **server** (`connectors.jira.assignees[serverId]`), migrated on load and persisted
    immediately; a dedicated two-column mapping dialog; members addable straight from the
    Jira user directory; renames propagate to every linked project's member list *and* its
    tasks; identities are never published to the epic property.
14. **Descriptions** — `adf.ts` converts ADF ⇄ Markdown; `description` became a synced
    field with canonical comparison, lazy body hydration, attachments round-tripping
    statelessly through their link (upgraded in place from the old `jira-media:` form),
    other unconvertible nodes stashed verbatim, and a side-by-side compare with a Markdown
    preview in the resolver. Two live failures drove it: a conflict resolution that adopted
    nothing locally and then pushed stale text back over Jira's, and a placeholder pushed
    as literal text that replaced a real attachment.
15. **Hierarchy both ways** — a cross-level move walked through legal intermediate states
    (detach → convert → re-attach), retyping decided by hierarchy *level* so a same-level
    move stops rewriting a Bug into a Task, `parent` promoted to a merged shadow field
    (a Jira-side move is adopted instead of silently reverted), and a move outside the
    root's subtree archives the task — keeping its key, so it is never recreated in Jira
    as a duplicate.
