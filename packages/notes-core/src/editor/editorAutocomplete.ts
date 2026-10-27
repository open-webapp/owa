import { acceptCompletion, autocompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete'
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'
import { dateSuggest } from '../dateSuggest.js'
import { listAutocompleteTags, type AutocompleteTagEntry } from '../tags.js'

type AutocompleteOptions = {
  getEntries: () => AutocompleteTagEntry[]
  getToday: () => string
}

function applyDate(view: EditorView, iso: string, from: number, to: number) {
  const trailing = view.state.sliceDoc(to).match(/^[\d\-/]*/)?.[0] ?? ''
  view.dispatch({ changes: { from, to: to + trailing.length, insert: `@${iso}` } })
}

function completionSource(options: AutocompleteOptions) {
  return (context: CompletionContext) => {
    const date = context.matchBefore(/@[A-Za-z\d\-/]*/)
    if (date) {
      const query = date.text.slice(1)
      if (!query) return null

      const suggestions = dateSuggest(query, options.getToday())
      if (!suggestions.length) return null

      return {
        from: date.from,
        filter: false,
        options: suggestions.map(({ label, iso }): Completion => ({
          label,
          detail: iso,
          apply: (view, _completion, from, to) => applyDate(view, iso, from, to),
        })),
      }
    }

    const tag = context.matchBefore(/#[\w:/-]*/)
    if (!tag) return null

    const names = listAutocompleteTags(options.getEntries(), tag.text.slice(1))
    if (!names.length) return null

    return {
      from: tag.from,
      filter: false,
      options: names.map((name): Completion => ({
        label: name,
        apply: `#${name}`,
      })),
    }
  }
}

const acceptCompletionOnKeydown = ViewPlugin.fromClass(class {
  private readonly view: EditorView
  private readonly onKeydown: (event: KeyboardEvent) => void

  constructor(view: EditorView) {
    this.view = view
    this.onKeydown = (event) => {
      if (
        (event.key !== 'Enter' && event.key !== 'Tab') ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !acceptCompletion(view)
      ) return

      event.preventDefault()
      event.stopImmediatePropagation()
    }
    // Atomic's inline preview claims Enter at highest keymap precedence.
    // Capture completion acceptance before that native keydown handler runs.
    view.dom.addEventListener('keydown', this.onKeydown, true)
  }

  destroy() {
    this.view.dom.removeEventListener('keydown', this.onKeydown, true)
  }
})

export function createAutocomplete(options: AutocompleteOptions): Extension[] {
  return [Prec.highest([
    autocompletion({
      activateOnTyping: true,
      selectOnOpen: true,
      interactionDelay: 0,
      defaultKeymap: true,
      icons: false,
      override: [completionSource(options)],
    }),
    keymap.of([
      { key: 'Enter', run: acceptCompletion },
      { key: 'Tab', run: acceptCompletion },
    ]),
    acceptCompletionOnKeydown,
  ])]
}
