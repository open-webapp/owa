# Notes Core Product Behavior

## Package

- Parses and formats Notes Diary dates, tags, sections, date metadata, quick-add text, date suggestions, filtering, Todo board groups, sticky navigation, image markdown, and tag trees.
- Provides deterministic filtering and grouping from supplied entries; functions do not load or save data.
- Merges a remote snapshot without deleting local-only entries. Newer `updatedAt` wins; local wins a tie. Local archived entries are not overwritten.
- With tombstones, deletion wins when `removedAt` is equal to or newer than an entry's `updatedAt` (missing is `0`). A newer entry revives; the greatest valid tombstone per ID remains indefinitely.
- Folds rule envelopes sequentially: first rule ID wins, and earlier entry folds win timestamp ties. Invalid envelope structure throws rather than returning partial output.
- Offers CodeMirror tag/date autocomplete separately at `@open-webapp/notes-core/editor`.

## Tag Grammar

- Tag = `#root` or `#root/child`; each part matches `[0-9A-Za-z][\w-]*(?::[\w-]+)*`. `#tag/123` is child `123`.
- `#a:b` is a root tag, not a child of `#a`.
- Partial tokens: `#a/b/c` -> `#a/b` + `/c`; `#work/` -> `#work` + `/`; `#work/1:` -> `#work/1` + `:`; `#work/a::b` -> `#work/a` + `::b`; `#work/_x`, `#work/:x` -> `#work` + plain suffix.
- 0.2.0 BREAKING vs 0.1.0: numeric children (`#tag/123`) previously parsed as `#tag` + plain `/123`. Stored Markdown is reinterpreted on read, never rewritten.

## Host

- Validates `Entry`, `Tombstone`, `FilterRule`, and envelope field values before use.
- Owns storage, JSON serialization, transport, conflict scheduling, UI, and CodeMirror setup.
- Installs CodeMirror peers when using the editor subpath.
- Exact-pins `@open-webapp/notes-core@0.2.0`.
- Releases through a checked branch PR and GitHub merge, then tags the merge commit `notes-core-v0.2.0` to publish.
