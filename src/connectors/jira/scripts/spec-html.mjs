/* Render the JIRA connector SPECIFICATION.md to a styled, self-contained
 * SPECIFICATION.html (table of contents + embedded CSS) via pandoc, so the HTML
 * stays in step with the markdown on every build.
 *
 * Runs as part of `pnpm build` (build:docs). Pandoc is an OPTIONAL, external tool:
 * if it isn't installed (e.g. a CI box without it) this logs a warning and skips —
 * it never fails the build. The markdown remains the source of truth.
 */
import { writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// This file lives at src/connectors/jira/scripts/ — repo root is four levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const mdPath = join(root, 'src/connectors/jira/docs/SPECIFICATION.md')
const outPath = join(root, 'src/connectors/jira/docs/SPECIFICATION.html')

if (!existsSync(mdPath)) {
  console.warn(`[spec-html] ${mdPath} not found — skipping.`)
  process.exit(0)
}

// Pandoc is optional; skip cleanly when it's unavailable so the build still passes.
if (spawnSync('pandoc', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.warn('[spec-html] pandoc not found — skipping SPECIFICATION.html (install pandoc to generate it).')
  process.exit(0)
}

const CSS = `<style>
  :root { --accent:#5b3fb0; --border:#e6e8eb; --muted:#687; }
  body { font: 15px/1.65 -apple-system, system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1.2rem 4rem; color:#1d1f23; }
  h1 { border-bottom:3px solid var(--accent); padding-bottom:.3rem; }
  h2 { margin-top:2.2rem; border-bottom:1px solid var(--border); padding-bottom:.25rem; color:var(--accent); }
  h3 { margin-top:1.6rem; }
  code { background:#f4f2fb; padding:.1em .35em; border-radius:4px; font-size:.9em; }
  pre { background:#f6f7f9; border:1px solid var(--border); border-radius:8px; padding:.8rem 1rem; overflow:auto; }
  pre code { background:none; padding:0; }
  table { border-collapse:collapse; width:100%; margin:1rem 0; }
  th,td { border:1px solid var(--border); padding:.4rem .6rem; text-align:left; vertical-align:top; }
  th { background:#f6f4fe; }
  a { color:var(--accent); }
  blockquote { border-left:3px solid var(--accent); margin:1rem 0; padding:.2rem 1rem; color:var(--muted); }
  #TOC { background:#faf9fe; border:1px solid var(--border); border-radius:10px; padding:1rem 1.4rem; font-size:.92em; }
  #TOC::before { content:"Contents"; font-weight:700; color:var(--accent); display:block; margin-bottom:.4rem; }
  #TOC ul { margin:.2rem 0; } #TOC a { text-decoration:none; }
  hr { border:0; border-top:1px solid var(--border); margin:2rem 0; }
</style>
`

const headerPath = join(mkdtempSync(join(tmpdir(), 'pm-spec-')), 'style.html')
writeFileSync(headerPath, CSS)

const res = spawnSync(
  'pandoc',
  [
    mdPath,
    '-s',
    '--toc',
    '--toc-depth=3',
    '--metadata',
    'title=JIRA Connector — Specification',
    '-H',
    headerPath,
    '-o',
    outPath
  ],
  { stdio: 'inherit' }
)

if (res.status !== 0) {
  console.warn(`[spec-html] pandoc exited ${res.status} — SPECIFICATION.html not updated.`)
  process.exit(0) // don't fail the build over an optional doc render
}
console.log('Wrote src/connectors/jira/docs/SPECIFICATION.html')
