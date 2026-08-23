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
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
      // Jira autolinks a pasted URL, giving a link whose text is the URL itself. Writing
      // that as "[url](url)" would be noise; the bare URL is the same thing and is what
      // Markdown renders as a link anyway.
      out = out === mark.attrs.href ? out : `[${out}](${mark.attrs.href})`
    }
  }
  return out
}

/**
 * Schemes for placeholders that can be turned back into the node they came from.
 *
 * An attachment carries its own identity, so it round-trips with no stored state: the
 * link holds the media id and its layout attributes, and a push rebuilds the node from
 * them. Anything else goes in a stash by token — there is nothing about an expand block
 * or a macro that could be reconstructed from its name alone.
 */
const MEDIA_SCHEME = 'jira-media:'
/** Fragment that carries the media identity on an otherwise ordinary Jira URL. */
const MEDIA_FRAGMENT = '#pm-media='
const NODE_SCHEME = 'jira-node:'

/** Nodes we couldn't express, kept so a push can put the originals back. */
export type AdfStash = Record<string, AdfNode>

const NODE_TOKEN_RE = /`jira-node:([A-Za-z0-9]+)`/g

/**
 * Placeholders in the text that this stash can't rebuild — the note was written
 * elsewhere, or the stash was lost. These are the only ones a caller must refuse to push:
 * writing them would replace a real node with the words describing it.
 */
export function unrestorablePlaceholders(md: string, stash?: AdfStash): string[] {
  const out: string[] = []
  for (const m of (md ?? '').matchAll(NODE_TOKEN_RE)) {
    if (!stash?.[m[1]]) out.push(m[0])
  }
  return out
}

/** The media node inside a mediaSingle/mediaGroup wrapper, or the node itself. */
function mediaOf(node: AdfNode): AdfNode | null {
  if (node.type === 'media') return node
  return (node.content ?? []).find((c) => c.type === 'media') ?? null
}

/**
 * An attachment as a link carrying everything needed to rebuild the node.
 *
 * When the issue's address is known the link points there, with the media identity in the
 * fragment: clicking it opens the issue in a browser — where the attachment is visible and
 * the session already exists — instead of doing nothing, which is what an unknown
 * "jira-media:" scheme does. The fragment is ignored by Jira and read back on the way home.
 */
function mediaLink(wrapper: AdfNode, media: AdfNode, issueUrl?: string): string {
  const a = media.attrs ?? {}
  const params = new URLSearchParams()
  const pairs: [string, unknown][] = [
    ['c', a.collection],
    ['w', a.width],
    ['h', a.height],
    ['t', a.type],
    ['l', wrapper.attrs?.layout]
  ]
  // Only scalars: an attribute holding an object would stringify to "[object Object]" and
  // silently corrupt the link rather than being left out.
  for (const [key, val] of pairs) {
    if (typeof val === 'string' && val) params.set(key, val)
    else if (typeof val === 'number') params.set(key, String(val))
  }
  const q = params.toString()
  const name = typeof a.alt === 'string' && a.alt ? a.alt : 'attachment'
  const id = typeof a.id === 'string' ? a.id : ''
  const payload = `${id}${q ? `&${q}` : ''}`
  return issueUrl
    ? `[${name}](${issueUrl}${MEDIA_FRAGMENT}${payload})`
    : `[${name}](${MEDIA_SCHEME}${id}${q ? `?${q}` : ''})`
}

/**
 * A node we can't represent, as something the reader can act on and we can rebuild.
 *
 * Never an image embed for an attachment: Jira's media URLs need authentication Obsidian's
 * renderer can't supply, so `![](…)` would render as a broken image. A link to the issue
 * opens where the session already exists.
 */
function placeholderFor(node: AdfNode, stash?: AdfStash, issueUrl?: string): string {
  const attrs = node.attrs ?? {}
  const url = typeof attrs.url === 'string' ? attrs.url : typeof attrs.href === 'string' ? attrs.href : ''
  const name = typeof attrs.alt === 'string' ? attrs.alt : typeof attrs.text === 'string' ? attrs.text : node.type
  if (url) return `[${name}](${url})`

  const media = mediaOf(node)
  if (media) return mediaLink(node, media, issueUrl)

  // Nothing about this node can be inferred from its name, so keep the original and
  // reference it by token. With nowhere to keep it, name it and let the caller refuse.
  if (!stash) return `\`${NODE_SCHEME}${node.type}\``
  const token = `n${Object.keys(stash).length + 1}${node.type
    .replace(/[^a-z]/gi, '')
    .toLowerCase()
    .slice(0, 6)}`
  stash[token] = node
  return `\`${NODE_SCHEME}${token}\``
}

function inline(nodes: AdfNode[] | undefined, stash?: AdfStash, issueUrl?: string): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') return applyMarks(n.text ?? '', n.marks)
      if (n.type === 'hardBreak') return '\n'
      if (n.type === 'emoji') return typeof n.attrs?.text === 'string' ? n.attrs.text : ''
      if (n.type === 'mention') return typeof n.attrs?.text === 'string' ? n.attrs.text : ''
      if (n.type === 'inlineCard') return placeholderFor(n, stash, issueUrl)
      return n.content ? inline(n.content, stash, issueUrl) : placeholderFor(n, stash, issueUrl)
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

function block(node: AdfNode, depth = 0, stash?: AdfStash, issueUrl?: string): string {
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
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
      // Handled here rather than falling through: the wrapper carries the layout, and
      // descending into it would reach the media node without it.
      return placeholderFor(node, stash, issueUrl)
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
      // With a stash, keep the node itself: it can then go back to Jira exactly as it
      // came. Without one — a read purely for display — descend instead, so the text
      // inside an unknown wrapper is at least visible.
      if (stash) return placeholderFor(node, stash, issueUrl)
      return node.content?.length
        ? (node.content ?? []).map((c) => block(c, depth, undefined, issueUrl)).join('\n')
        : placeholderFor(node, undefined, issueUrl)
  }
}

/**
 * Convert a description to Markdown. Accepts the ADF document, or a plain string for the
 * v2 API and for older issues whose description was never migrated.
 */
export function adfToMarkdown(doc: unknown, stash?: AdfStash, issueUrl?: string): string {
  if (doc == null) return ''
  if (typeof doc === 'string') return doc.trim()
  const root = doc as AdfNode
  if (!Array.isArray(root.content)) return ''
  return root.content
    .map((n) => block(n, 0, stash, issueUrl))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Markdown → ADF ──────────────────────────────────────────────────────────

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\[[^\]]*\]\([^)]*\))|(_[^_]+_)|(\*[^*]+\*)|(https?:\/\/[^\s<>()[\]]+)/

/** Split a line into ADF text nodes, applying the marks we can represent. */
/** Rebuild the media node a jira-media link stands for. */
function mediaFromLink(alt: string, payload: string): AdfNode {
  const [id, query] = payload.split(/[?&](.+)/)
  const q = new URLSearchParams(query ?? '')
  const attrs: Record<string, unknown> = { id, type: q.get('t') ?? 'file' }
  if (alt && alt !== 'attachment') attrs.alt = alt
  if (q.get('c')) attrs.collection = q.get('c')
  if (q.get('w')) attrs.width = Number(q.get('w'))
  if (q.get('h')) attrs.height = Number(q.get('h'))
  return {
    type: 'mediaSingle',
    attrs: { layout: q.get('l') ?? 'center' },
    content: [{ type: 'media', attrs }]
  }
}

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
    } else if (/^https?:\/\//.test(tok)) {
      // A pasted URL is a link in Jira; leaving it as text would render it dead there.
      out.push({ type: 'text', text: tok, marks: [{ type: 'link', attrs: { href: tok } }] })
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

/** A line that is nothing but a placeholder becomes the node it stands for. */
function restoreLine(line: string, stash?: AdfStash): AdfNode | null {
  const media = /^\[([^\]]*)\]\(\S*(?:jira-media:|#pm-media=)([^)]*)\)$/.exec(line)
  if (media) return mediaFromLink(media[1], media[2])
  const token = /^`jira-node:([A-Za-z0-9]+)`$/.exec(line)
  return (token && stash?.[token[1]]) || null
}

/**
 * Markdown → ADF, for writing a description back to Jira.
 *
 * A deliberately small subset: the block and inline forms {@link adfToMarkdown} produces,
 * so text that came from Jira survives the trip home. Anything else — a table, an
 * Obsidian embed — is carried across as literal text in a paragraph rather than dropped,
 * which keeps the content and makes the gap visible instead of silent.
 */
export function markdownToAdf(md: string, stash?: AdfStash): AdfNode {
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

    // A whole line that is just one placeholder is the node itself, put back as it was.
    const restored = restoreLine(line.trim(), stash)
    if (restored) {
      flush()
      content.push(restored)
      continue
    }

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
