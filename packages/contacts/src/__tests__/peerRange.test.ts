import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type V = [number, number, number]
const parse = (s: string): V => {
  const [a = 0, b = 0, c = 0] = s.split('.').map(Number)
  return [a, b, c]
}
const cmp = (x: V, y: V): number => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]

// Handles `||`-separated caret ranges only (e.g. "^2.1.0 || ^4.0.0").
function satisfies(version: string, range: string): boolean {
  const v = parse(version)
  return range.split('||').some((part) => {
    const m = /^\^(\d+(?:\.\d+){0,2})$/.exec(part.trim())
    if (!m) return false
    const min = parse(m[1] as string)
    return v[0] === min[0] && cmp(v, min) >= 0
  })
}

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
) as {
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
}

describe('vitest peer range', () => {
  const range = pkg.peerDependencies.vitest as string
  it('accepts vitest 2.1.9', () => {
    expect(satisfies('2.1.9', range)).toBe(true)
  })
  it('accepts vitest 4.0.0', () => {
    expect(satisfies('4.0.0', range)).toBe(true)
  })
  it('accepts vitest 4.1.0', () => {
    expect(satisfies('4.1.0', range)).toBe(true)
  })
  it('keeps vitest peer optional', () => {
    expect(pkg.peerDependenciesMeta.vitest?.optional).toBe(true)
  })
})
