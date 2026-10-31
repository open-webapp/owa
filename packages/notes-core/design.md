# @open-webapp/notes-core Design

## Modules

- `dateUtils`: validation, ISO parsing, date/time formatting, relative time.
- `tags`: tag (`TAG_RE`: root + one optional digit-or-letter-leading child) and `@date` token parsing, sections, entry metadata, autocomplete tag extraction.
- `mode`, `entryFiltering`: display-mode derivation and entry/section/tab filtering.
- `stickyGroups`, `stickyOpen`: Todo board data and sticky navigation resolution.
- `quickAdd`, `dateSuggest`: date-tagged quick-add text and date completions.
- `noteImages`: Drive image URL, upload-name, placeholder-token, and markdown reconciliation helpers.
- `tagSearch`: tag-tree filtering.
- `mergeRemoteEntries`, `foldRuleEnvelopes`: backup reconciliation and rule-envelope folding.
- `editor`: optional CodeMirror autocomplete adapter, published only at `./editor`.

## Boundaries

- Main-entry modules are pure: no React, browser storage, network, filesystem, or JSON I/O.
- Hosts own persistence, validation of entry/rule fields, transport, serialization, and UI state.
- `Entry.updatedAt` is the merge clock; missing values are the oldest value (`0`). Archive is local authority: an archived local entry cannot be remotely replaced.
- Tombstones are durable deletion records. Per ID, only the greatest finite `removedAt` remains; it suppresses equal-or-older entries and a strictly newer entry revives.
- Fold validates envelope shape before applying each item, keeps the first rule ID, and applies legacy entry merges in source order.
- The editor adapter owns the CodeMirror imports; consumers install its four CodeMirror peer dependencies only when using that subpath.

## Packaging

`package.json` exports only `.` and `./editor`, ships `dist` and `README.md`, and is public npm package `@open-webapp/notes-core` at `0.2.0`. Consumers exact-pin this pre-1.0 version. Tagging merge commit `notes-core-v0.2.0` invokes the publish workflow.
