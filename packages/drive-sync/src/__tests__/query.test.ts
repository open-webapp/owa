import { describe, expect, it } from 'vitest'
import { escapeQ } from '../query.js'

describe('escapeQ (test case 23)', () => {
  it('passes through a plain string with no special characters unchanged', () => {
    expect(escapeQ('plain-name.txt')).toBe('plain-name.txt')
  })

  it("escapes a single quote in a name (e.g. O'Brien)", () => {
    expect(escapeQ("O'Brien")).toBe("O\\'Brien")
  })

  it('escapes a backslash in a name (e.g. a\\b)', () => {
    expect(escapeQ('a\\b')).toBe('a\\\\b')
  })

  it('escapes the backslash BEFORE the quote when a name contains both', () => {
    // Input is a literal backslash followed by a literal single quote: \'
    // If the quote were escaped first, the backslash just inserted before
    // it would then get doubled too, producing the wrong "\\\'" -> "\\\\'"
    // in the wrong order. Escaping the backslash first (per query.ts's
    // documented rule) yields "\\" for the backslash, then "\'" for the
    // quote: \\\'
    const input = "\\'"
    expect(escapeQ(input)).toBe("\\\\\\'")
  })
})
