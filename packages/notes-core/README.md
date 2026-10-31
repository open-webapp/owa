# @open-webapp/notes-core

Pure Notes Diary domain helpers. The main entry point has no React, storage, network, or JSON I/O.

## Install

```bash
npm install --save-exact @open-webapp/notes-core@0.2.0
```

Consumers must exact-pin `0.2.0`; this pre-1.0 package may change on a minor release.

## Tag Grammar

Tag: `#` + root + optional single child. Root and child each match `[0-9A-Za-z][\w-]*(?::[\w-]+)*` (`TAG_RE`); child follows `/`.

- `#a:b` is one root tag, not a child of `#a`; `:` segments belong to the root or child they follow.
- Partial tokens end at the last valid piece; the rest is plain text: `#a/b/c` -> `#a/b` + `/c`; `#work/` -> `#work` + `/`; `#work/1:` -> `#work/1` + `:`; `#work/a::b` -> `#work/a` + `::b`; `#work/_x` and `#work/:x` -> `#work` + `/_x`, `/:x`.

### Release note: 0.2.0 is BREAKING (0.1.0 to 0.2.0)

- Children may start with a digit: `#tag/123` is now child `123` of `#tag`. In 0.1.0 it parsed as `#tag` + plain text `/123`.
- Stored Markdown is reinterpreted on read; nothing is rewritten.
- Hosts must exact-pin `0.2.0`.

## Entry Points

| Import | Contents |
| --- | --- |
| `@open-webapp/notes-core` | Pure dates, tags, filtering, sticky grouping, quick add, image-text, merge, and fold helpers; all public types |
| `@open-webapp/notes-core/editor` | `createAutocomplete` CodeMirror extension factory |

`@open-webapp/notes-core/editor` requires peer dependencies `@codemirror/autocomplete`, `@codemirror/commands`, `@codemirror/state`, and `@codemirror/view` (`^6.0.0`).

## Types

```ts
type Entry = {
  id: string; date: string; time: string; text: string; archived?: boolean;
  doneAt?: number; createdAt: number; updatedAt?: number;
}
type Tombstone = { id: string; removedAt: number }
type FilterRule = { id: string; filter: string; fileName: string; isRemainder: boolean }
```

`date` is ISO `YYYY-MM-DD`; `time` is `HH:MM`; timestamps are epoch milliseconds. Missing `updatedAt` is `0` for merging.

## Merge And Fold

`mergeRemoteEntries(local, remote)` returns `Entry[]`. It preserves local-only entries, uses newer `updatedAt` for duplicate IDs (local wins ties), and never replaces a local archived entry. Invalid remote `doneAt` values are ignored.

`mergeRemoteEntries(local, remote, { local, remote })` returns `{ entries, tombstones }`. It keeps the maximum finite numeric `removedAt` tombstone per ID. A tombstone removes an entry when `removedAt >= (updatedAt ?? 0)`; a strictly newer entry revives. Tombstones are retained forever.

`foldRuleEnvelopes(envelopes)` returns `{ entries, filterRules }`. It folds envelopes sequentially with the legacy two-argument merge, so earlier folds win timestamp ties. The first rule ID wins. It throws for a malformed envelope; fields inside otherwise shaped entries/rules are host-validated. It performs no I/O or JSON serialization.

## Release

Create a branch and PR, pass required checks, merge through GitHub, then tag the merge commit `notes-core-v0.2.0`. The tag triggers package build, test, and public npm publish.
