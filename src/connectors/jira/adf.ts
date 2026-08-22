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
