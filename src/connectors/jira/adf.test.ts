import { describe, expect, it } from 'vitest'
import { adfToMarkdown, markdownToAdf, unrestorablePlaceholders } from './adf'

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })
const p = (...content: unknown[]) => ({ type: 'paragraph', content })
const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) })

describe('adfToMarkdown', () => {
  it('converts paragraphs, separated by a blank line', () => {
    expect(adfToMarkdown(doc(p(t('First.')), p(t('Second.'))))).toBe('First.\n\nSecond.')
  })

  it('converts the inline marks', () => {
    const marks = doc(
      p(
        t('plain '),
        t('bold', [{ type: 'strong' }]),
        t(' '),
        t('italic', [{ type: 'em' }]),
        t(' '),
        t('mono', [{ type: 'code' }]),
        t(' '),
        t('gone', [{ type: 'strike' }])
      )
    )
    expect(adfToMarkdown(marks)).toBe('plain **bold** _italic_ `mono` ~~gone~~')
  })

  it('converts a link, and a link that is also bold', () => {
    const link = [{ type: 'link', attrs: { href: 'https://example.com' } }]
    expect(adfToMarkdown(doc(p(t('see', link))))).toBe('[see](https://example.com)')
    expect(adfToMarkdown(doc(p(t('see', [{ type: 'strong' }, ...link]))))).toBe('[**see**](https://example.com)')
  })

  it('converts headings, rules and hard breaks', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Title')] },
      p(t('one'), { type: 'hardBreak' }, t('two')),
      { type: 'rule' }
    )
    expect(adfToMarkdown(d)).toBe('## Title\n\none\ntwo\n\n---')
  })

  it('converts bullet and ordered lists', () => {
    const li = (s: string) => ({ type: 'listItem', content: [p(t(s))] })
    expect(adfToMarkdown(doc({ type: 'bulletList', content: [li('a'), li('b')] }))).toBe('- a\n- b')
    expect(adfToMarkdown(doc({ type: 'orderedList', content: [li('a'), li('b')] }))).toBe('1. a\n2. b')
  })

  it('converts code blocks with their language', () => {
    const d = doc({ type: 'codeBlock', attrs: { language: 'bash' }, content: [t('echo hi')] })
    expect(adfToMarkdown(d)).toBe('```bash\necho hi\n```')
  })

  it('converts a blockquote and a panel to quoted lines', () => {
    expect(adfToMarkdown(doc({ type: 'blockquote', content: [p(t('quoted'))] }))).toBe('> quoted')
    expect(adfToMarkdown(doc({ type: 'panel', attrs: { panelType: 'info' }, content: [p(t('note'))] }))).toBe('> note')
  })

  it('renders a mention and an emoji as their text', () => {
    const d = doc(p({ type: 'mention', attrs: { text: '@Ada' } }, t(' '), { type: 'emoji', attrs: { text: '🎉' } }))
    expect(adfToMarkdown(d)).toBe('@Ada 🎉')
  })

  /*
   * The point of the placeholders: a node we can't represent has to survive as something
   * visible, or a round trip would quietly delete content from the issue.
   */
  it('links an attachment rather than embedding it — the URL needs auth Obsidian cannot send', () => {
    const media = {
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file', alt: 'Screenshot.png' } }]
    }
    expect(adfToMarkdown(doc(media))).toBe('[Screenshot.png](jira-media:abc-123?t=file&l=center)')
  })

  it('keeps an unknown node visible, and in the stash so it can go back', () => {
    const stash = {}
    const md = adfToMarkdown(doc({ type: 'expand', attrs: { title: 'Details' } }), stash)
    expect(md).toMatch(/^`jira-node:\w+`$/)
    expect(Object.values(stash)).toEqual([{ type: 'expand', attrs: { title: 'Details' } }])
  })

  it('names an unknown node when there is nowhere to keep it', () => {
    expect(adfToMarkdown(doc({ type: 'expand', attrs: {} }))).toBe('`jira-node:expand`')
  })

  it('follows an unknown wrapper into its children rather than discarding them', () => {
    const d = doc({ type: 'someWrapper', content: [p(t('still here'))] })
    expect(adfToMarkdown(d)).toBe('still here')
  })

  it('accepts a plain string, for the v2 API and un-migrated issues', () => {
    expect(adfToMarkdown('  just text  ')).toBe('just text')
  })

  it('is empty for nothing at all', () => {
    expect(adfToMarkdown(null)).toBe('')
    expect(adfToMarkdown(undefined)).toBe('')
    expect(adfToMarkdown({ type: 'doc', version: 1 })).toBe('')
  })
})

describe('markdownToAdf', () => {
  const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })

  it('makes a paragraph, with blank lines separating them', () => {
    expect(markdownToAdf('One.\n\nTwo.')).toEqual(doc(p(t('One.')), p(t('Two.'))))
  })

  it('turns a single newline into a hard break, not a new paragraph', () => {
    expect(markdownToAdf('one\ntwo')).toEqual(doc(p(t('one'), { type: 'hardBreak' }, t('two'))))
  })

  it('reads the inline marks back', () => {
    expect(markdownToAdf('**b** _i_ `c` ~~s~~')).toEqual(
      doc(
        p(
          t('b', [{ type: 'strong' }]),
          t(' '),
          t('i', [{ type: 'em' }]),
          t(' '),
          t('c', [{ type: 'code' }]),
          t(' '),
          t('s', [{ type: 'strike' }])
        )
      )
    )
  })

  it('reads a link back', () => {
    expect(markdownToAdf('[text](https://x.test)')).toEqual(
      doc(p(t('text', [{ type: 'link', attrs: { href: 'https://x.test' } }])))
    )
  })

  it('stores "no description" the way Jira does, not as an empty doc', () => {
    expect(markdownToAdf('')).toEqual(doc({ type: 'paragraph', content: [] }))
  })
})

/*
 * The property the sync depends on. If a description that came from Jira doesn't survive
 * the trip home unchanged, every sync would see a remote edit nobody made and rewrite the
 * note — so these are the cases we're allowed to claim support for.
 */
describe('tables', () => {
  const cell = (text: string, header = false) => ({
    type: header ? 'tableHeader' : 'tableCell',
    attrs: {},
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })
  const row = (...cells: unknown[]) => ({ type: 'tableRow', content: cells })

  it('reads a Jira table as a Markdown table', () => {
    const table = {
      type: 'table',
      content: [row(cell('Env', true), cell('Host', true)), row(cell('prod'), cell('a.example'))]
    }
    expect(adfToMarkdown({ type: 'doc', version: 1, content: [table] })).toBe(
      '| Env | Host |\n| --- | --- |\n| prod | a.example |'
    )
  })

  it('escapes a bar inside a cell so it does not split the row', () => {
    const table = { type: 'table', content: [row(cell('a|b', true), cell('c', true))] }
    expect(adfToMarkdown({ type: 'doc', version: 1, content: [table] })).toContain('| a\\|b | c |')
  })

  it('writes the first row back as header cells', () => {
    const adf = markdownToAdf('| a | b |\n| --- | --- |\n| 1 | 2 |')
    const rows = adf.content?.[0]?.content ?? []
    expect(adf.content?.[0]?.type).toBe('table')
    expect(rows[0]?.content?.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader'])
    expect(rows[1]?.content?.map((c) => c.type)).toEqual(['tableCell', 'tableCell'])
  })
})

/*
 * The whole point of the placeholders: what Markdown can't express still has to reach
 * Jira unchanged. Anything less makes a description Jira-only, which it isn't.
 */
describe('placeholders go back as the nodes they came from', () => {
  it('links an attachment to its issue, so clicking it goes somewhere', () => {
    const media = {
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file', alt: 'Shot.png' } }]
    }
    const md = adfToMarkdown({ type: 'doc', version: 1, content: [media] }, {}, 'https://acme.test/browse/ENG-1')
    expect(md).toBe('[Shot.png](https://acme.test/browse/ENG-1#pm-media=abc-123&t=file&l=center)')
    // And it still rebuilds: the fragment Jira ignores is what we read back.
    expect(markdownToAdf(md).content?.[0]).toEqual(media)
  })

  it('rebuilds an attachment, with its layout attributes', () => {
    const media = {
      type: 'mediaSingle',
      attrs: { layout: 'wide' },
      content: [
        { type: 'media', attrs: { id: 'abc-123', type: 'file', collection: 'coll-9', width: 320, alt: 'Shot.png' } }
      ]
    }
    const md = adfToMarkdown({ type: 'doc', version: 1, content: [media] })
    expect(markdownToAdf(md).content?.[0]).toEqual(media)
  })

  it('rebuilds a stashed node verbatim', () => {
    const expand = { type: 'expand', attrs: { title: 'Details' }, content: [p(t('hidden'))] }
    const stash = {}
    const md = adfToMarkdown({ type: 'doc', version: 1, content: [expand] }, stash)
    expect(markdownToAdf(md, stash).content?.[0]).toEqual(expand)
  })

  it('reports a placeholder it can no longer rebuild, rather than writing the words', () => {
    const stash = {}
    const md = adfToMarkdown({ type: 'doc', version: 1, content: [{ type: 'expand', attrs: {} }] }, stash)
    expect(unrestorablePlaceholders(md, stash)).toEqual([]) // stash intact
    expect(unrestorablePlaceholders(md, {})).toHaveLength(1) // stash lost
  })

  it('carries an attachment through an edit around it', () => {
    const media = {
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{ type: 'media', attrs: { id: 'x1', type: 'file' } }]
    }
    const md = adfToMarkdown({ type: 'doc', version: 1, content: [p(t('Before.')), media] })
    const edited = `${md}\n\nAfter.`
    const back = markdownToAdf(edited)
    expect(back.content?.map((n) => n.type)).toEqual(['paragraph', 'mediaSingle', 'paragraph'])
  })
})

describe('adf round trip', () => {
  // The property the sync depends on. If a description that came from Jira doesn't survive
  // the trip home unchanged, every sync would see a remote edit nobody made and rewrite the
  // note — so this list is exactly what we're allowed to claim support for.
  it.each([
    ['paragraphs', 'One.\n\nTwo.'],
    ['a hard break', 'one\ntwo'],
    ['inline marks', '**b** _i_ `c` ~~s~~'],
    ['a link', 'See [the doc](https://x.test) first.'],
    ['headings', '# One\n\n## Two\n\n### Three'],
    ['a bullet list', '- a\n- b\n- c'],
    ['an ordered list', '1. a\n2. b'],
    ['a fenced code block', '```bash\necho hi\nexit 0\n```'],
    ['a quote', '> quoted'],
    ['a rule', '---'],
    ['a mixed document', '# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```js\nconst a = 1\n```\n\n> note'],
    ['a table', '| Env | Host |\n| --- | --- |\n| prod | a.example |\n| dev | b.example |'],
    ['a table with formatting in a cell', '| Field | Note |\n| --- | --- |\n| **id** | see [doc](https://x.test) |'],
    // Bars with no separator line aren't a table; leaving them as text beats guessing.
    ['bars that are not a table', '| a | b |']
  ])('survives %s', (_name, md) => {
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md)
  })
})
