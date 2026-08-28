/* Generate the JIRA connector coverage report straight from the test files — no
 * hand-maintained matrix, so it can't drift. Each test `describe(...)` block is one
 * interaction area; its direction comes from a trailing tag in the describe name,
 * e.g. `describe('jira sync — export [O→J]', ...)`. Untagged blocks default to `unit`.
 * Every `it(...)` under a block is one covered interaction.
 *
 * Runs as part of `pnpm build` (build:docs) → src/connectors/jira/docs/coverage.html
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file lives at src/connectors/jira/scripts/ — repo root is four levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const TEST_DIR = 'src/connectors/jira'
const outRel = 'src/connectors/jira/docs/coverage.html'

// Discover every *.test.ts under the connector (including ui/), so a new test file
// is picked up automatically.
function testFiles(rel) {
  const out = []
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'docs') out.push(...testFiles(join(rel, e.name)))
    else if (e.name.endsWith('.test.ts')) out.push(join(rel, e.name))
  }
  return out
}

// Direction = an explicit trailing tag on the describe name, e.g. `... [O→J]`.
// Untagged blocks are `unit`. This is the only per-test annotation — keep it on the
// describe so adding a test never touches this script.
const KNOWN_DIRS = new Set(['O→J', 'J→O', 'both', 'HTTP', 'unit', 'setup', 'Obsidian'])

/** Parse describe/it (both quote styles), grouping it-titles under their describe + direction. */
function parseGroups(rel) {
  const text = readFileSync(join(root, rel), 'utf8')
  const re = /\b(describe|it)\(\s*(['"])((?:\\.|(?!\2).)*)\2/g
  const groups = []
  let current = null
  let m
  while ((m = re.exec(text))) {
    const title = m[3].replace(/\\(['"])/g, '$1')
    if (m[1] === 'describe') {
      const tag = title.match(/\s*\[([^\]]+)\]\s*$/)
      const dir = tag ? tag[1] : 'unit'
      current = { file: rel, name: title.replace(/\s*\[[^\]]+\]\s*$/, ''), dir, tests: [] }
      groups.push(current)
    } else if (current) {
      current.tests.push(title)
    } else {
      current = { file: rel, name: '(top level)', dir: 'unit', tests: [title] }
      groups.push(current)
    }
  }
  return groups
}

const groups = testFiles(TEST_DIR).flatMap(parseGroups)
const totalTests = groups.reduce((n, g) => n + g.tests.length, 0)
for (const g of groups) {
  if (!KNOWN_DIRS.has(g.dir)) console.warn(`[coverage] unknown direction "${g.dir}" on "${g.name}" (${g.file})`)
}

// ── Editorial sections (not per-test, so they don't drift with the suite) ──────
const CONFIDENCE = [
  [
    'Core sync (CRUD, import/export, links, assignees, milestone)',
    9.5,
    'Exercised end-to-end over HTTP: parent-first create, hierarchy, dependencies via issuelinks, dates, assignees, milestone bag. Deleting a task in Obsidian ignores its key (never deletes the Jira issue, no re-import bounce-back).'
  ],
  [
    'Reconciliation — 3-way merge & no data loss',
    9.5,
    'Every synced field (incl. dependencies) merges against a per-task shadow base: disjoint edits auto-merge, both-sided edits surface as conflicts, rejected pushes hold the shadow and retry. Closes the earlier status-only gap where non-status fields were silent last-writer-wins.'
  ],
  [
    'Descriptions (ADF ⇄ Markdown)',
    8.0,
    'Converted both ways in adf.ts (paragraphs, headings, marks, links, bare URLs, lists, code blocks, quotes, panels, rules, mentions, emoji, tables), compared canonically so a lossy round trip is not read as a remote edit, and pushed only when every placeholder can be restored — attachments through their own link, other nodes from a verbatim stash. Unit-tested both directions plus end-to-end through runSync. Marked down, not up: three defects came from real issue descriptions that the synthetic tests had passed, and the converter has still seen only a handful of real ones.'
  ],
  [
    'Hierarchy & issue types (two-way)',
    9.0,
    'parent is a merged shadow field held as a Jira key: a move here is pushed (carrying the issuetype change a level move needs, walked through detach → convert → re-attach because Jira validates parent against the current type), a move in Jira is adopted as a local move, a move on both sides is a conflict, and a move outside the root subtree archives the task — keeping its key so it is never recreated as a duplicate. Retyping is decided by hierarchy level, so a same-level move no longer rewrites a Bug into a Task. Covered end-to-end in parent.test.ts, each case verified by reverting the fix.'
  ],
  [
    'Conflict resolution UI',
    9.0,
    'Per-field Obsidian⇄Jira resolver with keep-all + per-field picks. The engine (threeWay / conflictFields / resolveConflict) is unit-tested; the modal is not yet covered by an automated DOM test but was manually validated end-to-end (both-sided status edit → JiraMergeModal → take-Jira → local adopts and the shadow settles with no re-push).'
  ],
  [
    'HTTP API faithfulness vs Jira Cloud docs',
    8.5,
    'Endpoints aligned incl. /search/jql, issueLink, entity properties, createmeta, the key-in / OR-combined subtree JQL, and id-based priority writes + transition matching. Cross-checked live against a real Jira Cloud instance: hierarchy, both JQL forms, createmeta start field, issue-type levels, link types, and screenless/global transitions all matched.'
  ],
  [
    'Outbound writes by id (priority/status/assignee)',
    9.0,
    'Priority written by persisted id (name fallback), status transitions matched by to.id, assignees by accountId — ids discovered once and stored in ext.jira, backfilled onto legacy maps. Covered by model + integration tests (incl. resolve-by-id-despite-stale-name).'
  ],
  [
    'Incremental polling & request economy',
    9.0,
    'The periodic tick is a subtree+watermark query (key in tracked OR parent in tracked/epic, updated > watermark) plus a key-in fetch for locally-dirty issues; instance metadata (issue types, start field) is cached per base, the epic config is pulled only on a full sync, and polling pauses while Obsidian is hidden. An idle tick issues no fetch. Covered end-to-end (incremental.test.ts).'
  ],
  [
    'Live-instance readiness',
    8.5,
    'A full outbound write is proven end-to-end on a real Jira Cloud instance: create under an Epic parent, summary, status transition, due date, start date, priority, assignee, and the obsidian-pm property — on top of the multi-level parent hierarchy, full + incremental JQL, createmeta discovery, issue-type level resolution, the Blocks link type, and screenless/global transitions. Getting there exposed five bugs the suite had passed (XSRF-refused writes, priority schemes, start-field discovery, silent start drop, instance-wide type levels); all are fixed and now modelled by the mock. Inbound reconcile and conflict resolution are still mock-only.'
  ]
]
const overall = (CONFIDENCE.reduce((s, [, v]) => s + v, 0) / CONFIDENCE.length).toFixed(1)
const RISKS = [
  [
    'LOW',
    'Company- vs team-managed projects',
    'Validated on a real company-managed project: the full (parent OR "Epic Link") and incremental (key-in OR parent-in) JQL run clean and "Epic Link" resolves. Other project styles still worth a first-run check.'
  ],
  [
    'LOW',
    'Transition screens / required fields',
    'Validated live: transitions across every issue type had no screen, no required fields, and were global. (If one ever does, the push is held and surfaces as a resolvable conflict, not lost.)'
  ],
  [
    'LOW',
    'Entity-property round-trip (obsidian-pm / -config)',
    'Confirmed live: the plugin-written obsidian-pm-config sits on the real epic (same setProperty/getProperty path the per-issue milestone bag uses). Milestone bag itself only re-exercises that mechanism.'
  ],
  [
    'MED',
    'Inbound reconcile against a real instance',
    'The 3-way merge, adopt/push split, and conflict resolution are proven on the mock and by a second client acting as a teammate, but not yet against real Jira: only outbound writes have been exercised live. Worth a deliberate two-sided edit on a throwaway epic before trusting interval sync.'
  ],
  [
    'MED',
    'Mock fidelity',
    "Every live bug so far passed the suite because the mock had been written to match the connector's assumptions. It now models real instance shapes (priority schemes, a missing Start date field, createmeta envelope variants, XSRF-refused writes, foreign issue types at wrong levels, and the issuelink POST-to-GET pairing) and each fix was verified by reverting it, but any NEW endpoint the mock hand-rolls carries the same risk until checked against a real payload. The sharpest case so far: the mock's link route mirrored the connector's own reading of inwardIssue/outwardIssue, so client and server cancelled out and every link test passed while real Jira received every dependency reversed. Facts that can only come from a real instance now get a test that pins the raw wire behaviour with no client involved."
  ],
  [
    'MED',
    'Description conversion against real content',
    'Every description defect so far came from real issue content, not the suite: a bare URL arriving in Jira as dead text, an attachment link that opened nothing, and a placeholder pushed as literal text that replaced a real attachment. Node types outside the converted set survive via the verbatim stash (safe, but not editable here), and a description is held rather than pushed when a placeholder can no longer be restored. Still worth checking each newly-synced description that contains anything beyond text.'
  ],
  [
    'LOW',
    'Generated body lines escaping into Jira',
    'Closed: the parent/project/subtask links are frontmatter properties, so the note body is the description and nothing else. Previously a generated line the strip patterns missed (trailing whitespace defeated the anchor) was pushed to Jira as a dead wiki-link, and the greedy ## Subtasks rule deleted user text below a heading of their own from both the note and the issue. The legacy patterns remain, tightened to the exact shape at the end of a body, for notes written before the change.'
  ],
  [
    'LOW',
    'In-memory tree vs the vault',
    'The project tree a sync reads is a snapshot and can be momentarily incomplete (a note read while being rewritten drops its task for that load; losing one file can leave a branch out of one pass). That was enough for one sync to offer a pile of already-linked issues for import — importing them would have duplicated live tasks. Import candidates are now re-checked against the task files on disk before being offered, and the mismatch is logged. Other consumers of the tree still trust it.'
  ],
  [
    'MED',
    'Permissions / rate limits (429)',
    'Failed writes surface as a conflict and retry next sync; no backoff yet. The incremental tick (subtree+watermark, cached metadata, paused while hidden) keeps request volume low, reducing 429 exposure.'
  ],
  [
    'LOW',
    'Conflict resolver UI (no automated DOM test)',
    'The 3-way engine, default picks, and resolveConflict are unit-tested, and the Resolve… flow was manually validated end-to-end (conflict detected → modal → per-field resolve → settled). Still no automated DOM test, so keep an eye on it after modal changes.'
  ],
  [
    'LOW',
    'Deep hierarchies',
    "Validated 4 levels deep on a real instance; create resolves the issue type by discovered hierarchy level and skips + flags anything nested below the lowest type. Status/priority maps need a one-time tune to the instance's own value names."
  ]
]
const ROLLOUT = [
  'Start on a throwaway/low-stakes epic.',
  'Connect and Load project settings; confirm statuses, priorities, assignees, and the epic look right.',
  'Import read-only; confirm hierarchy, dependencies, assignees, and dates.',
  'Export ONE new task; verify type/parent/fields; then edit on both sides and sync.',
  'Confirm a status transition works for your workflow (an "out of sync" flag means it was rejected — open Resolve… to see why).',
  'Deliberately create a conflict: change the SAME field on both sides, sync, then open Resolve… and confirm both "keep mine" and "take Jira" behave.',
  'Check one issue whose description has more than plain text (a table, an attachment, a link): sync, read it back in Jira, and confirm nothing was flattened or replaced by placeholder text.',
  'Move an issue in Jira — to another task under the root, then out of the root entirely — and confirm the first is adopted and the second archives the task locally.',
  'Only then enable interval sync for the project.'
]

// ── Render ─────────────────────────────────────────────────────────────────────
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const dirClass = (d) => d.replace(/[^a-z]/gi, '')
const badge = (d) => `<span class="dir dir-${dirClass(d)}">${esc(d)}</span>`

const rows = groups
  .map(
    (g) => `
    <tr class="group"><td colspan="2">${esc(g.name)} ${badge(g.dir)} <span class="muted">${g.tests.length}</span></td></tr>
    ${g.tests.map((t) => `<tr><td>${esc(t)}</td><td class="file">${esc(g.file.replace('src/connectors/jira/', ''))}</td></tr>`).join('\n')}`
  )
  .join('\n')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>JIRA connector — coverage</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 2rem auto; max-width: 1040px; color: #1d1f23; padding: 0 1rem; }
  h1 { margin-bottom: .2rem; } .sub { color: #687; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }
  td, th { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #e6e8eb; vertical-align: top; }
  tr.group td { background: #efeafc; font-weight: 700; color: #5b3fb0; }
  .muted { color: #8a7fb0; font-weight: 400; } .file { color: #889; font-size: 12px; white-space: nowrap; }
  .dir { font-size: 11px; font-weight: 700; padding: .08rem .4rem; border-radius: 999px; }
  .dir-OJ { background: #dcefe0; color: #1c7a37; } .dir-JO { background: #dbe8ff; color: #1f5bd6; }
  .dir-both { background: #fdebcf; color: #9a6212; } .dir-Obsidian { background: #ece7fb; color: #5b3fb0; }
  .dir-HTTP { background: #e6e8eb; color: #444; } .dir-unit { background: #f0f0f0; color: #666; } .dir-setup { background: #e8f0ee; color: #2a6b5e; }
  .stat { display: inline-block; background: #f6f7f9; border: 1px solid #e6e8eb; border-radius: 8px; padding: .4rem .7rem; margin-right: .5rem; }
  .score { display: flex; gap: 1.2rem; align-items: flex-start; background: #f6f4fe; border: 1px solid #e0d8fb; border-radius: 12px; padding: 1rem 1.2rem; margin: 1rem 0; }
  .score-num { font-size: 3rem; font-weight: 800; color: #5b3fb0; line-height: 1; } .score-num span { font-size: 1.1rem; color: #8a7fb0; }
  .conf { width: 100%; } .conf td { border: 0; padding: .15rem .4rem; } .conf td:nth-child(2) { color: #5b3fb0; text-align: right; width: 3rem; }
  .sev { font-size: 11px; font-weight: 700; padding: .08rem .4rem; border-radius: 4px; }
  .sev-HIGH { background: #f7d4d4; color: #a12; } .sev-MED { background: #fde8c8; color: #95610f; }
  footer { color: #889; margin-top: 2rem; font-size: 12px; }
</style></head>
<body>
  <h1>JIRA connector — coverage</h1>
  <p class="sub">Generated from the test files (one section per <code>describe</code>, one row per <code>it</code>). All sync tests run end-to-end through the real JiraClient against the in-process local server over HTTP.</p>
  <p>
    <span class="stat"><strong>${totalTests}</strong> tests</span>
    <span class="stat"><strong>${groups.length}</strong> areas</span>
    <span class="stat">${badge('O→J')} ${badge('J→O')} ${badge('both')} ${badge('Obsidian')} ${badge('HTTP')} ${badge('unit')}</span>
  </p>

  <div class="score">
    <div class="score-num">${overall}<span>/10</span></div>
    <div>
      <strong>Confidence for live testing</strong>
      <table class="conf">${CONFIDENCE.map(([d, v, n]) => `<tr><td>${esc(d)}</td><td><b>${v.toFixed(1)}</b></td><td>${esc(n)}</td></tr>`).join('')}</table>
      <p>Ready for a staged live trial. Core sync and reconciliation (full per-field 3-way merge, closing the earlier non-status data-loss gap), incremental polling, and id-based outbound writes are strongly covered and tested, and the connector's key assumptions were cross-checked live against a real Jira Cloud instance (multi-level parent hierarchy, full + incremental JQL, createmeta/start field, issue-type levels, link types, screenless/global transitions). Do a one-time status/priority map tune after Load settings to match the instance's value names. Open items: the conflict-resolver dialog (engine tested, UI not e2e), the entity-property round-trip, and permissions/rate-limits.</p>
    </div>
  </div>

  <h2>Residual risks before live</h2>
  <table><thead><tr><th>Sev</th><th>Risk &amp; mitigation</th></tr></thead><tbody>
    ${RISKS.map(([s, r, d]) => `<tr><td><span class="sev sev-${s}">${s}</span></td><td><strong>${esc(r)}</strong> — ${esc(d)}</td></tr>`).join('')}
  </tbody></table>

  <h2>Recommended live rollout</h2>
  <ol>${ROLLOUT.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>

  <h2>Coverage by area</h2>
  <table><thead><tr><th>Interaction (test)</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
  <footer>Auto-generated by src/connectors/jira/scripts/coverage-report.mjs during build — do not edit by hand.</footer>
</body></html>`

mkdirSync(join(root, 'src/connectors/jira/docs'), { recursive: true })
writeFileSync(join(root, outRel), html)
console.log(`Wrote ${outRel} — ${totalTests} tests across ${groups.length} areas.`)
