/**
 * Atlassian Document Format → Markdown.
 *
 * Jira Cloud's v3 API stores a description as an ADF tree, not text. This converts the
 * nodes we can represent faithfully and turns everything else into a visible placeholder
 * rather than dropping it — see {@link placeholderFor}. That's what makes a partial
 * converter safe: an unsupported node survives a round trip as something a human can see
 * and we can recognise, instead of silently disappearing from the note.
 */

export interface AdfNode {
  type: string
  /** Only on the root doc node. */
  version?: number
  text?: string
  content?: AdfNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  attrs?: Record<string, unknown>
}

/** Marks in application order — innermost first, so a bold link nests the right way. */
const MARK_WRAPPERS: Record<string, [string, string]> = {
  code: ['`', '`'],
  strong: ['**', '**'],
  em: ['_', '_'],
  strike: ['~~', '~~']
}

function applyMarks(text: string, marks: AdfNode['marks']): string {
  let out = text
  for (const mark of marks ?? []) {
    const wrap = MARK_WRAPPERS[mark.type]
    if (wrap) out = wrap[0] + out + wrap[1]
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') out = `[${out}](${mark.attrs.href})`
  }
  return out
}

/**
 * A node we can't represent. Rendered as a link when there's somewhere to point (an
 * attachment, an embedded page) and as a labelled marker otherwise — always something the
 * reader can act on, never a silent gap.
 *
 * Deliberately not an image embed for media: Jira attachment URLs need authentication that
 * Obsidian's renderer can't supply, so `![](…)` would render as a broken image. A link
 * opens in the browser, where the session already exists.
 */
/** Recognises the markers {@link placeholderFor} emits. */
export const PLACEHOLDER_RE = /`\[jira [^\]]*\]`/

/**
 * True when the text carries a marker standing in for something we couldn't convert.
 *
 * Pushing such text would replace the real node in Jira with the words describing it —
 * an attachment becomes the literal string "[jira attachment <id>]" and the file is gone
 * from the description. Callers must refuse the write instead.
 */
export function hasPlaceholder(md: string): boolean {
  return PLACEHOLDER_RE.test(md ?? '')
}

function placeholderFor(node: AdfNode): string {
  const attrs = node.attrs ?? {}
  const url = typeof attrs.url === 'string' ? attrs.url : typeof attrs.href === 'string' ? attrs.href : ''
  const name = typeof attrs.alt === 'string' ? attrs.alt : typeof attrs.text === 'string' ? attrs.text : node.type
  if (url) return `[${name}](${url})`
  if (node.type === 'media' || node.type === 'mediaSingle' || node.type === 'mediaGroup') {
    const id = typeof attrs.id === 'string' ? attrs.id : ''
    return `\`[jira attachment${id ? ` ${id}` : ''}]\``
  }
  return `\`[jira ${node.type}]\``
}

function inline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') return applyMarks(n.text ?? '', n.marks)
      if (n.type === 'hardBreak') return '\n'
      if (n.type === 'emoji') return typeof n.attrs?.text === 'string' ? n.attrs.text : ''
      if (n.type === 'mention') return typeof n.attrs?.text === 'string' ? n.attrs.text : ''
      if (n.type === 'inlineCard') return placeholderFor(n)
      return n.content ? inline(n.content) : placeholderFor(n)
    })
    .join('')
}

function listItems(node: AdfNode, ordered: boolean, depth: number): string[] {
  const pad = '  '.repeat(depth)
  return (node.content ?? []).flatMap((item, i) => {
    const marker = ordered ? `${i + 1}.` : '-'
    const [first, ...rest] = (item.content ?? []).map((child) => block(child, depth + 1))
    const head = `${pad}${marker} ${(first ?? '').trimStart()}`
    return [head, ...rest.filter(Boolean)]
  })
}

/** A cell's text on one line — a Markdown table row can't contain block structure. */
function cellText(cell: AdfNode, depth: number): string {
  return (cell.content ?? [])
    .map((c) => block(c, depth))
    .join(' ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|') // a bar inside a cell would end it
    .trim()
}

/**
 * ADF table → a GitHub-style Markdown table. The first row becomes the header, which is
 * what Jira's tables have and what Markdown requires; a table with no header row would
 * otherwise have nowhere to put its separator.
 */
function tableToMarkdown(node: AdfNode, depth: number): string {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow')
  if (!rows.length) return ''
  const lines = rows.map((r) => `| ${(r.content ?? []).map((c) => cellText(c, depth)).join(' | ')} |`)
  const width = (rows[0].content ?? []).length
  lines.splice(1, 0, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
  return lines.join('\n')
}

function block(node: AdfNode, depth = 0): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content)
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
      return `${'#'.repeat(level)} ${inline(node.content)}`
    }
    case 'bulletList':
      return listItems(node, false, depth).join('\n')
    case 'orderedList':
      return listItems(node, true, depth).join('\n')
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      return `\`\`\`${lang}\n${inline(node.content)}\n\`\`\``
    }
    case 'blockquote':
      return (node.content ?? [])
        .map((c) => block(c, depth))
        .join('\n')
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n')
    case 'rule':
      return '---'
    case 'table':
      return tableToMarkdown(node, depth)
    case 'panel':
      // A panel's body is ordinary content; a callout keeps the emphasis without inventing
      // syntax Jira can't express back.
      return (node.content ?? [])
        .map((c) => block(c, depth))
        .join('\n')
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n')
    case 'text':
      return inline([node])
    default:
      return node.content?.length ? (node.content ?? []).map((c) => block(c, depth)).join('\n') : placeholderFor(node)
  }
}

/**
 * Convert a description to Markdown. Accepts the ADF document, or a plain string for the
 * v2 API and for older issues whose description was never migrated.
 */
export function adfToMarkdown(doc: unknown): string {
  if (doc == null) return ''
  if (typeof doc === 'string') return doc.trim()
  const root = doc as AdfNode
  if (!Array.isArray(root.content)) return ''
  return root.content
    .map((n) => block(n))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Markdown → ADF ──────────────────────────────────────────────────────────

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\[[^\]]*\]\([^)]*\))|(_[^_]+_)|(\*[^*]+\*)/

/** Split a line into ADF text nodes, applying the marks we can represent. */
function inlineNodes(text: string): AdfNode[] {
  if (!text) return []
  const out: AdfNode[] = []
  let rest = text
  for (;;) {
    const m = INLINE.exec(rest)
    if (!m || m.index === undefined) break
    if (m.index > 0) out.push(...plain(rest.slice(0, m.index)))
    const tok = m[0]
    if (tok.startsWith('`')) out.push(marked(tok.slice(1, -1), 'code'))
    else if (tok.startsWith('**')) out.push(marked(tok.slice(2, -2), 'strong'))
    else if (tok.startsWith('~~')) out.push(marked(tok.slice(2, -2), 'strike'))
    else if (tok.startsWith('[')) {
      const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(tok)
      if (link) {
        out.push({
          type: 'text',
          text: link[1] || link[2],
          marks: [{ type: 'link', attrs: { href: link[2] } }]
        })
      }
    } else out.push(marked(tok.slice(1, -1), 'em'))
    rest = rest.slice(m.index + tok.length)
  }
  if (rest) out.push(...plain(rest))
  return out
}

/** Plain run, with newlines becoming hard breaks — ADF text nodes can't contain them. */
function plain(text: string): AdfNode[] {
  const parts = text.split('\n')
  const out: AdfNode[] = []
  parts.forEach((part, i) => {
    if (i) out.push({ type: 'hardBreak' })
    if (part) out.push({ type: 'text', text: part })
  })
  return out
}

function marked(text: string, mark: string): AdfNode {
  return { type: 'text', text, marks: [{ type: mark }] }
}

const TABLE_ROW = /^\s*\|(.*)\|\s*$/
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/

/** Split "| a | b |" into its cells, respecting an escaped bar. */
function rowCells(line: string): string[] {
  const inner = TABLE_ROW.exec(line)?.[1] ?? ''
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

/**
 * A Markdown table becomes an ADF table, first row as the header — the shape
 * {@link tableToMarkdown} produces, so a table survives the round trip intact.
 *
 * Requires the separator line: a lone "| a | b |" is just text with bars in it, and
 * turning that into a one-row table would be a worse guess than leaving it alone.
 */
function tableNode(rows: string[][]): AdfNode {
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: rows.map((cells, row) => ({
      type: 'tableRow',
      content: cells.map((cell) => ({
        type: row === 0 ? 'tableHeader' : 'tableCell',
        attrs: {},
        content: [paragraph(cell)]
      }))
    }))
  }
}

function paragraph(text: string): AdfNode {
  return { type: 'paragraph', content: inlineNodes(text) }
}

function listNode(items: string[], ordered: boolean): AdfNode {
  return {
    type: ordered ? 'orderedList' : 'bulletList',
    content: items.map((item) => ({ type: 'listItem', content: [paragraph(item)] }))
  }
}

/**
 * Markdown → ADF, for writing a description back to Jira.
 *
 * A deliberately small subset: the block and inline forms {@link adfToMarkdown} produces,
 * so text that came from Jira survives the trip home. Anything else — a table, an
 * Obsidian embed — is carried across as literal text in a paragraph rather than dropped,
 * which keeps the content and makes the gap visible instead of silent.
 */
export function markdownToAdf(md: string): AdfNode {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n')
  const content: AdfNode[] = []
  let para: string[] = []
  let list: { items: string[]; ordered: boolean } | null = null

  const flushPara = () => {
    if (para.length) content.push(paragraph(para.join('\n')))
    para = []
  }
  const flushList = () => {
    if (list) content.push(listNode(list.items, list.ordered))
    list = null
  }
  const flush = () => {
    flushPara()
    flushList()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i])
      const node: AdfNode = { type: 'codeBlock', content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] }
      if (fence[1]) node.attrs = { language: fence[1] }
      content.push(node)
      continue
    }

    if (!line.trim()) {
      flush()
      continue
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush()
      const rows = [rowCells(line)]
      i++ // the separator carries no data
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]) && !TABLE_RULE.test(lines[i + 1])) {
        rows.push(rowCells(lines[++i]))
      }
      content.push(tableNode(rows))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      content.push({ type: 'heading', attrs: { level: heading[1].length }, content: inlineNodes(heading[2]) })
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      content.push({ type: 'rule' })
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      const body: string[] = [quote[1]]
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ''))
      content.push({ type: 'blockquote', content: [paragraph(body.join('\n'))] })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      const match = bullet ?? ordered
      if (!match) continue
      const isOrdered = Boolean(ordered)
      const text = match[1]
      flushPara()
      if (list && list.ordered !== isOrdered) flushList()
      list = list ?? { items: [], ordered: isOrdered }
      list.items.push(text)
      continue
    }

    flushList()
    para.push(line)
  }
  flush()

  // Jira rejects an empty doc; a single empty paragraph is how it stores "no description".
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] }
}
