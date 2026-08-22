import { describe, expect, it } from 'vitest'
import { adfToMarkdown } from './adf'

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
      content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file', alt: 'Screenshot.png' } }]
    }
    expect(adfToMarkdown(doc(media))).toBe('`[jira attachment abc-123]`')
  })

  it('keeps an unknown node visible instead of dropping it', () => {
    expect(adfToMarkdown(doc({ type: 'expand', attrs: {} }))).toBe('`[jira expand]`')
    expect(adfToMarkdown(doc({ type: 'status', attrs: { text: 'DONE' } }))).toBe('`[jira status]`')
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
