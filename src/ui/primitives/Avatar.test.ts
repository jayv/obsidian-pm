import { describe, expect, it } from 'vitest'
import { displayName, initialsFor, initialsRoster } from './Avatar'

describe('displayName', () => {
  it('returns a plain name unchanged', () => {
    expect(displayName('Jane Doe')).toBe('Jane Doe')
  })

  it('trims a plain name', () => {
    expect(displayName('  Jane Doe  ')).toBe('Jane Doe')
  })

  it('unwraps a bare wikilink', () => {
    expect(displayName('[[Jane Doe]]')).toBe('Jane Doe')
  })

  it('strips the folder path from a bare wikilink', () => {
    expect(displayName('[[People/Team/Jane Doe]]')).toBe('Jane Doe')
  })

  it('prefers the alias when present', () => {
    expect(displayName('[[People/Jane Doe|JD]]')).toBe('JD')
  })

  it('trims the alias', () => {
    expect(displayName('[[People/Jane Doe| JD ]]')).toBe('JD')
  })

  it('falls back to the path when the alias is empty', () => {
    expect(displayName('[[People/Jane Doe|]]')).toBe('Jane Doe')
  })

  it('drops a file extension', () => {
    expect(displayName('[[People/Jane Doe.md]]')).toBe('Jane Doe')
  })

  it('drops a heading reference', () => {
    expect(displayName('[[People/Jane Doe#Bio]]')).toBe('Jane Doe')
  })

  it('drops a block reference', () => {
    expect(displayName('[[People/Jane Doe#^abc123]]')).toBe('Jane Doe')
  })

  it('keeps a dot inside a name', () => {
    expect(displayName('[[People/Jane.Doe]]')).toBe('Jane.Doe')
  })

  it('keeps a version-style name with a dot', () => {
    expect(displayName('[[v1.2 release]]')).toBe('v1.2 release')
  })

  it('leaves a non-wikilink string with brackets alone', () => {
    expect(displayName('[[unterminated')).toBe('[[unterminated')
  })
})

/*
 * Two letters stop identifying people as soon as a team has a "Jay Dean" and a
 * "Jo Delorie". Initials are therefore a property of the whole roster, not of one name.
 */
describe('initialsRoster', () => {
  const of = (names: string[]) => Object.fromEntries(initialsRoster(names))

  it('leaves distinct initials at two letters', () => {
    expect(of(['Ada Lovelace', 'Grace Hopper'])).toEqual({ 'Ada Lovelace': 'AL', 'Grace Hopper': 'GH' })
  })

  it('takes another letter from the first name when two collide', () => {
    expect(of(['Jay Dean', 'Jo Delorie'])).toEqual({ 'Jay Dean': 'JaD', 'Jo Delorie': 'JoD' })
  })

  it('widens the last name next, and only for the names still clashing', () => {
    expect(of(['Jay Dean', 'Jo Delorie', 'Jane Dorethy'])).toEqual({
      'Jay Dean': 'JaDe',
      'Jane Dorethy': 'JaDo',
      'Jo Delorie': 'JoD' // already unambiguous — stays short
    })
  })

  it('does not hand out an initial a shorter name already claimed', () => {
    const roster = initialsRoster(['Jay Dean', 'Jo Delorie', 'Jane Dorethy'])
    expect(new Set(roster.values()).size).toBe(3)
  })

  it('handles single-word names and duplicates', () => {
    expect(of(['Madonna', 'Mary Jane'])).toEqual({ Madonna: 'Ma', 'Mary Jane': 'MJ' })
    // The same person written twice is one person, not a collision to solve.
    expect(of(['Ada Lovelace', 'Ada Lovelace'])).toEqual({ 'Ada Lovelace': 'AL' })
  })

  it('answers to a wikilink assignee by either its stored or display form', () => {
    const roster = initialsRoster(['[[Jay Dean]]', '[[Jo Delorie]]'])
    expect(roster.get('[[Jay Dean]]')).toBe('JaD')
    expect(roster.get('Jay Dean')).toBe('JaD') // the gantt looks up by display name
    expect(roster.get('Jo Delorie')).toBe('JoD')
  })

  it('ignores blanks', () => {
    expect(of(['', '  ', 'Ada Lovelace'])).toEqual({ 'Ada Lovelace': 'AL' })
  })

  it('falls back to two letters for a lone name', () => {
    expect(initialsFor('Ada Lovelace')).toBe('AL')
  })
})
