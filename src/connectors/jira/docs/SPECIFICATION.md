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
```

```
JiraShadow   = { title; status; priority; start; due; assignees: string[]; milestone: boolean; blockedBy: string[] }
JiraConflict = { theirs: JiraShadow }   // JIRA side at detection; the live diff is recomputed in the UI
```

`blockedBy` holds the JIRA keys the task is "blocked by" (its dependencies), so links
are merged field-by-field like everything else.

### 3.5 Entity-property bags (stored on JIRA issues)

- `ISSUE_PROP` on each issue — `{ milestone?: boolean }`. Shared fact only.
- `CONFIG_PROP` on the epic — `{ statusMap, priorityMap }`. The shared mapping config
  other Obsidian users adopt. Assignee mappings are deliberately **not** published: they
  are name↔accountId pairs, and there is no reason to store identities in Jira.

### 3.6 Settings accessors

- `servers(plugin)`, `setServers` (preserves sibling keys), `serverById`.
- `getToken/setToken` — secret keyed `jira:{serverId}` in `connectorSecrets`.
- `getDebug/setDebug` — the API debug-logging flag.
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

## 6. Issue normalization (`normalizeIssue(raw, startFieldId?)`)

Maps a raw JIRA issue → `JiraIssue`:

```
key, summary, status (fields.status.name), statusCategory,
priority (fields.priority.name), assigneeAccountId, assigneeName,
start = fields[startFieldId] (if id known), due = fields.duedate,
updated, parentKey = fields.parent.key,
issueType = fields.issuetype.name,
isSubtask = fields.issuetype.subtask === true || /sub-?task/i.test(name),
blockedBy = keys of issuelinks where type.inward === 'is blocked by' (inwardIssue.key),
blockLinks = those links with their { id, key }
```

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
- `shadowOf(task, keyOf?)` = the `JiraShadow` fields from the task; `blockedBy` =
  `desiredBlockerKeys(task, keyOf)` when a key map is given, else `[]`.
- `assigneeField(task, cfg)`: no assignee → `null` (unassign); mapped → `{accountId}`;
  assignee present but unmapped → `undefined` (omit — don't clobber).
- `withJiraKey(task, key, keyOf, cfg, startField)` links a just-created task: `ext.jira =
  {key, sync:true, shadow}`. The shadow records **what was actually pushed** — when
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
conflicts, skippedTooDeep, newIssues }`. Requires `cfg.enabled` and `cfg.epicId`.

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
2. Index local tasks (by id, by key, parentOf, `keyOf`).
3. **Create** opted-in keyless tasks (parent-first, both modes): for each flat task with
   no `key` and `sync === true`, lazily `buildTypePlan` (so a no-create tick fetches no
   type metadata), resolve the child type via `childTypeFor` (skip + `skippedTooDeep` when
   nested below the lowest type), `pushNewIssue` with the parent's key; record key; patch
   the task `ext` with `{key, sync:true, shadow}`. Then `reconcileLinks` per created task.
4. **Fetch the JIRA side** then **reconcile** every linked & synced task with a single
   **3-way merge** against its issue (see 8.3).
   - **full**: `all = epicDescendants(epic)` (BFS crawl, O(depth) `parent in` queries).
   - **incremental**: `all = changedInSubtree(trackedKeys, epic, watermark)`; for any
     locally-dirty tracked key (shadow diverged or `reconciled === false`) not already in
     that result, also `issuesByKeys(missing)` so a local-only edit still pushes.
   Index by key; track `maxUpdated`. Issues in `all` that are not a local task, not created
   this run, and not in `ignoredKeys` → `newIssues`. Then for each flat task with `sync`
   and `key` (issues absent from `all` are simply skipped — unchanged):
   - `mine = shadowOf(task, keyOf)`; `localDiverged = !ext.shadow || mine ≠ ext.shadow`.
     Skip (no HTTP) when `!localDiverged && issue.updated ≤ prevWatermark &&
     ext.reconciled !== false`.
   - `theirs` from the issue (`resolveAssignee` may auto-create a mapped member);
     `blockedBy = issue.blockedBy`. `base = ext.shadow ?? theirs`.
   - `tw = threeWay(mine, base, theirs)` (8.3). If `tw.conflicts` non-empty →
     `flagConflict(task, theirs)` (`reconciled:false`, `conflict:{theirs}`), keep local,
     `conflicts++`, continue. **The shadow is NOT advanced**, so the next sync re-examines it.
   - **Push** `tw.push` fields: `summary`/`duedate`/`[startField]`/`priority` via
     `editIssue` (`priority` = `priorityRef(mapOutboundEntry)` → id or name); `status` via
     `transitionTo(status.jira, status.id)` from `mapOutboundEntry`; `milestone` via
     `setProperty(ISSUE_PROP)`; `blockedBy` via `reconcileLinks(key, issue.blockLinks,
     desiredBlockerKeys)`. A `priority`/`status` with no canonical outbound, an
     `assignee` whose local member has no JIRA-user mapping (`assigneeField === undefined`),
     a `start` with **no discovered start field**, or any rejected write is *held*: named in
     a `held[]` reason list, logged as `[PM] Jira: {key} held back — {reasons}`, and treated
     as a failure. These are surfaced, never silently dropped — a held field that left
     `fields` empty would skip the edit entirely and still advance the shadow, losing the
     change (how start dates vanished live).
     If held/`!ok` → `flagConflict(task, theirs)`, `conflicts++`, continue (no shadow advance).
     Else `jiraUpdated++` if `tw.push` non-empty.
   - **Adopt** `tw.adopt` fields into a task patch (`status`/`priority`/`title`/`start`/
     `due`/`assignees`/`type`; `blockedBy` → `dependencies` via key→id). `obsidianUpdated++`
     if `tw.adopt` non-empty.
   - Advance the shadow to the **merged baseline** (adopted fields take JIRA's value, the
     rest stay local) and clear `reconciled`/`conflict`.
5. `cfg.dirtyQueue = []`; `lastSeenUpdated = maxUpdated`; `lastSyncAt = now`.
6. `pushEpicConfig`: if `mappingsDirty`, `setProperty(epic, CONFIG_PROP, {maps})`,
   clear the flag.
7. `applyExternalUpdates(project, patches)` (store-level, persists).

The dirty queue is now only a hint for `syncTick` (which tasks to look at first); the
3-way merge is what decides push/adopt/conflict, so a rejected push isn't "lost" —
the shadow stays behind and the next sync retries.

### 8.3 `threeWay(mine, base, theirs)` (`reconcile.ts`)

The single reconcile primitive, applied per field over `SYNC_FIELDS` (the eight
`JiraShadow` keys). `fieldsEqual` compares scalars by `===` and arrays (`assignees`,
`blockedBy`) as unordered sets.

| condition (per field)          | classification                  |
| ------------------------------ | ------------------------------- |
| `mine == theirs`               | already agree — nothing to do   |
| `mine == base` (we didn't touch it) | **adopt** JIRA's value     |
| `theirs == base` (they didn't) | **push** our value              |
| otherwise (both changed)       | **conflict** `{field, mine, theirs}` |

Returns `{ push: SyncField[], adopt: SyncField[], conflicts: FieldConflict[] }`.

### 8.3a `resolveConflict(plugin, project, task, takeTheirs: SyncField[])`

User-driven conflict resolution. For each field in `takeTheirs`, apply JIRA's captured
value (`ext.conflict.theirs`) to the task (`blockedBy` → `dependencies` via key→id);
every other field keeps its local value. Reset `shadow = theirs` (the new baseline) and
clear `reconciled`/`conflict`. Persist via `applyExternalUpdates`. Because the baseline
is now JIRA's snapshot, kept-local fields differ from it and the next sync **pushes**
them, while taken fields already match and stay put.

### 8.4 `reconcileLinks(client, blockedKey, currentLinks, desired)`

For each `k` in `desired` not in `current` → `createLink(blockedKey, k)`. For each
`l` in `current` not in `desired` → `deleteLink(l.id)`. Returns true iff all succeeded.
`desiredBlockerKeys(task, keyOf)` = `task.dependencies` mapped to keys that exist.

### 8.5 `resolveAssignee(project, issue)`

Find a mapping by `jiraUser === assigneeAccountId || assigneeName`.
`name = found?.name ?? assigneeName ?? assigneeAccountId`. If not found, push a new
mapping `{name, jiraUser, jiraDisplay}` and set `mappingsDirty`. **Always** ensure
`name` is in `project.teamMembers`. Return name (or null when the issue has no
assignee).

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
Inbound is intentionally asymmetric: a linked task whose issue is no longer found is left
untouched (a missing issue may be out-of-scope or transient — never delete local data on
JIRA absence).

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
assignee/unassign/dependencies/milestone/dates/hierarchy; map validation; merges never
duplicate a JIRA value; all I/O over HTTP.

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

---

## 13. Testing

- **Unit**: `JiraModel`, `JiraMock`, `taskLink`, value-map validation.
- **HTTP integration**: real `JiraClient` ↔ local server (`JiraMockServer.test`).
- **End-to-end** (`sync.test`): a fake plugin/store over an in-memory vault drives
  `runSync`/import/export against the live local server over HTTP, including a second
  `JiraClient` acting as a teammate working solely in JIRA.
- **Coverage report**: `scripts/coverage-report.mjs` (under the connector) derives the
  report from the test files — one area per `describe`, one row per `it` →
  `docs/coverage.html` (interaction matrix + confidence score + residual-risk audit).
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
