// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import * as main from '../index.js'
import * as editor from '../editor/index.js'
import * as dateUtils from '../dateUtils.js'
import * as tags from '../tags.js'
import * as mode from '../mode.js'
import * as entryFiltering from '../entryFiltering.js'
import * as stickyGroups from '../stickyGroups.js'
import * as stickyOpen from '../stickyOpen.js'
import * as quickAdd from '../quickAdd.js'
import * as dateSuggest from '../dateSuggest.js'
import * as noteImages from '../noteImages.js'
import * as tagSearch from '../tagSearch.js'
import * as mergeRemoteEntries from '../mergeRemoteEntries.js'
import * as foldRuleEnvelopes from '../foldRuleEnvelopes.js'
import type { Entry, FilterRule, Tombstone } from '../index.js'
import type * as types from '../types.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pureExports = {
  ...dateUtils,
  ...tags,
  ...mode,
  ...entryFiltering,
  ...stickyGroups,
  ...stickyOpen,
  ...quickAdd,
  ...dateSuggest,
  ...noteImages,
  ...tagSearch,
  ...mergeRemoteEntries,
  ...foldRuleEnvelopes,
}

function filesWithin(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesWithin(path) : [path]
  })
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: packageRoot, stdio: 'pipe' })
}, 60_000)

describe('package entrypoints', () => {
  it('exports every pure source symbol from the main entry', () => {
    expect(Object.keys(main).sort()).toEqual(Object.keys(pureExports).sort())
    for (const [name, value] of Object.entries(pureExports)) {
      expect(main[name as keyof typeof main], name).toBe(value)
    }
    expectTypeOf<Entry>().toEqualTypeOf<types.Entry>()
    expectTypeOf<Tombstone>().toEqualTypeOf<types.Tombstone>()
    expectTypeOf<FilterRule>().toEqualTypeOf<types.FilterRule>()
  })

  it('keeps editor and private helpers out of the main entry', () => {
    expect(main).not.toHaveProperty('createAutocomplete')
    expect(main).not.toHaveProperty('hashEntries')
    expect(Object.keys(editor)).toEqual(['createAutocomplete'])
    expect(editor.createAutocomplete).toBeTypeOf('function')
  })

  it('builds usable main and editor JavaScript entries', async () => {
    const builtMain = await import('../../dist/index.js')
    const builtEditor = await import('../../dist/editor/index.js')
    expect(Object.keys(builtMain).sort()).toEqual(Object.keys(pureExports).sort())
    expect(builtMain.parseFlexibleDate('2026-10-03')).toBe('2026-10-03')
    expect(builtMain).not.toHaveProperty('createAutocomplete')
    expect(builtMain).not.toHaveProperty('hashEntries')
    expect(Object.keys(builtEditor)).toEqual(['createAutocomplete'])
    expect(builtEditor.createAutocomplete).toBeTypeOf('function')
  })

  it('contains no CodeMirror references in non-editor dist files', () => {
    const dist = join(packageRoot, 'dist')
    const files = readdirSync(dist, { withFileTypes: true })
      .filter(entry => entry.name !== 'editor')
      .flatMap(entry => entry.isDirectory()
        ? filesWithin(join(dist, entry.name))
        : [join(dist, entry.name)])
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('@codemirror')
    }
  })

  it('ships every JavaScript and declaration path in the exports map', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>
    }
    expect(manifest.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './editor': { types: './dist/editor/index.d.ts', default: './dist/editor/index.js' },
    })
    for (const entry of Object.values(manifest.exports)) {
      for (const path of Object.values(entry)) {
        expect(existsSync(resolve(packageRoot, path)), path).toBe(true)
      }
    }
  })
})
