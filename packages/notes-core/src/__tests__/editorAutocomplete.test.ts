import { acceptCompletion, currentCompletions, setSelectedCompletion, startCompletion } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAutocomplete } from '../editor/editorAutocomplete.js'

const entries = [
  { id: '1', text: '#project #work', createdAt: 0 },
]

const views: EditorView[] = []

const rangeGeometry = {
  getClientRects: Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects'),
  getBoundingClientRect: Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect'),
}

beforeAll(() => {
  // jsdom has no layout, but CodeMirror measures text ranges when rendering.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => Object.assign([], { item: () => null }) },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  })
})

afterAll(() => {
  for (const [name, descriptor] of Object.entries(rangeGeometry)) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor)
    else Reflect.deleteProperty(Range.prototype, name)
  }
})

async function createView(doc: string, cursor = doc.length, sourceEntries = entries) {
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: createAutocomplete({ getEntries: () => sourceEntries, getToday: () => '2026-10-03' }),
    }),
  })
  views.push(view)
  view.focus()
  startCompletion(view)
  await new Promise(resolve => setTimeout(resolve, 200))
  return view
}

afterEach(() => {
  while (views.length) views.pop()!.destroy()
  document.body.replaceChildren()
})

describe('createAutocomplete', () => {
  it('suggests and applies dates and matching tags', async () => {
    const dateView = await createView('@tom')
    expect(currentCompletions(dateView.state).map(({ label }) => label)).toContain('Tomorrow')
    dateView.dispatch({ effects: setSelectedCompletion(0) })
    expect(acceptCompletion(dateView)).toBe(true)
    expect(dateView.state.doc.toString()).toBe('@2026-10-04')
    expect(dateView.state.selection.main.anchor).toBe(11)
    expect(dateView.state.selection.main.head).toBe(11)

    const tagView = await createView('#pro')
    expect(currentCompletions(tagView.state).map(({ label }) => label)).toEqual(['project'])
    expect(acceptCompletion(tagView)).toBe(true)
    expect(tagView.state.doc.toString()).toBe('#project')
    expect(tagView.state.selection.main.anchor).toBe(8)
    expect(tagView.state.selection.main.head).toBe(8)

    const allTagsView = await createView('#')
    expect(currentCompletions(allTagsView.state).map(({ label }) => label)).toEqual(['project', 'work'])
  })

  it('renders each completion label and detail only once', async () => {
    const dateView = await createView('@1')
    const dateOption = Array.from(dateView.dom.querySelectorAll('.cm-completionLabel'))
      .find(option => option.textContent === 'Thu, Jan 1')
    expect(dateOption).toBeTruthy()
    expect(dateOption!.parentElement?.querySelector('.cm-completionDetail')?.textContent).toBe('2026-01-01')

    const tagView = await createView('#1', undefined, [{ id: '1', text: '#1:1', createdAt: 0 }])
    expect(Array.from(tagView.dom.querySelectorAll('.cm-completionLabel'))
      .filter(option => option.textContent === '1:1')).toHaveLength(1)
    expect(tagView.dom.querySelector('.cm-completion-date')).toBeNull()
  })

  it('replaces a date token after the caret and leaves Mod-Enter unhandled', async () => {
    const view = await createView('@12-25-1', 5)
    const targetIndex = currentCompletions(view.state).findIndex(({ label }) => label === 'Fri, Dec 25')
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    view.dispatch({ effects: setSelectedCompletion(targetIndex) })
    expect(acceptCompletion(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('@2026-12-25')
    // Preserve the source's selection mapping for a caret inside the replaced token.
    expect(view.state.selection.main.anchor).toBe(0)
    expect(view.state.selection.main.head).toBe(0)

    const keyEvent = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true })
    expect(runScopeHandlers(view, keyEvent, 'editor')).toBe(false)
  })

  it('does not offer completions for unsupported or unmatched input', async () => {
    for (const doc of ['@', 'plain text', '@zzz', '#zzz']) {
      const view = await createView(doc)
      expect(currentCompletions(view.state)).toEqual([])
      expect(view.state.doc.toString()).toBe(doc)
    }

    const noTags = await createView('#', undefined, [])
    expect(currentCompletions(noTags.state)).toEqual([])
    expect(noTags.state.doc.toString()).toBe('#')
  })
})
