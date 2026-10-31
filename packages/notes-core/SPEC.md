# @open-webapp/notes-core SPEC

## Scope

Framework-free Notes Diary helpers at `.`; CodeMirror integration only at `./editor`.

## Public Surface

### Dates

`isValidCalendarDate`, `parseFlexibleDate`, `getTodayISO`, `formatDate`, `formatDateWithYear`, `computeDaysAgo`, `formatMonthWithYear`, `formatTime`, and `formatRelativeTime` validate, parse, format, or compare calendar dates/times.

### Tags And Modes

`splitParts`, `splitSections`, `splitPartsWithDate`, `extractTags`, `listAutocompleteTags`, `isTagOnlySection`, `getEntryLevelTags`, `getEntryLevelDate`, `getExplicitSectionDate`, `resolveSectionDates`, `parseSectionDate`, and `findAcceptedDateToken` parse tags and `@date` metadata. `SECTION_DATE_TOKEN_RE` and `TAG_RE` are the corresponding patterns. `TAG_RE` grammar: `#` + `[0-9A-Za-z][\w-]*(?::[\w-]+)*` root + at most one `/` child of the same shape; digit-leading children are valid. `#a:b` is a root tag, not a child of `#a`. Partial tokens split at the last valid piece (`#a/b/c` -> `#a/b` + `/c`; `#work/` -> `#work` + `/`; `#work/1:` -> `#work/1` + `:`; `#work/a::b` -> `#work/a` + `::b`; `#work/_x`, `#work/:x` -> `#work` + plain suffix). `deriveMode` resolves `search > tag/date > all`.

Types: `AutocompleteTagEntry`, `Part`, `DateToken`, `AlreadyEmitted`, `ViewMode`.

### Filtering And Todo Groups

`filterEntries`, `filterEntriesForTab`, `filterParagraphsInEntry`, `filterParagraphsForTab`, `matchesDateTab`, `sectionDateForTab`, `dateMatchesSelection`, and `tagMatchesSelected` filter entries/sections. `groupTodoBoard` builds upcoming, past-due, and completed groups; `colorFor`, `rotFor`, `saturationFor`, and `upcomingAgeLabel` supply presentation values. `resolveStickyOpen` resolves an active entry and whether filters must clear.

Types: `DateTab`, `StickyRow`, `Day`, `PastItem`, `SectionSource`, `PastWeek`, `PastMonth`, `TodoBoard`.

### Quick Add, Suggestions, And Images

`buildQuickAddText` appends a valid date token; `quickAddChipDates` builds today/tomorrow/later chips. `dateSuggest` returns date completions. Type: `DateSuggestion`.

`DRIVE_IMAGE_URL_RE`, `buildDriveViewUrl`, `parseDriveImageUrl`, and `extractDriveImageFileIds` handle Drive view URLs. `ACCEPTED_IMAGE_MIME`, `EXT_BY_MIME`, `MAX_IMAGE_BYTES`, `isAcceptedImageType`, `isWithinSizeCap`, `shortRandomId`, `slugifyBaseName`, and `buildUploadFilename` implement image-upload constraints and names. `buildUploadingToken`, `UPLOADING_TOKEN_RE`, `replaceUploadingToken`, `reconcileTokenInText`, and `removeDriveImageMarkdown` manage persisted markdown image tokens. `filterTagTree` filters a `TagNode` tree. Type: `TagNode`.

### Sync Helpers

`mergeRemoteEntries` merges entries, optionally with tombstones. `foldRuleEnvelopes` folds rule backup envelopes. Types: `Entry`, `Tombstone`, `FilterRule`.

### Editor

`@open-webapp/notes-core/editor` exports `createAutocomplete({ getEntries, getToday })`, which returns CodeMirror extensions for `#tag` and `@date` completion.

## Merge Contract

- Two arguments, or an omitted/`undefined` third argument: returns `Entry[]`.
- A tombstone options object: returns `{ entries, tombstones }`.
- Duplicate IDs use last-write-wins by `updatedAt ?? 0`; local wins ties. Local-only entries remain. Local archived entries are protected from remote replacement.
- Invalid remote `doneAt` values do not replace or add an entry.
- For each ID, retain the maximum finite numeric `removedAt` across local and remote tombstones. `removedAt >= updatedAt ?? 0` removes the entry; only a strictly newer entry survives. Retained tombstones are never pruned.

## Fold Contract

- Envelopes are processed in input order.
- The first `FilterRule` for an ID wins.
- Entries merge sequentially with the two-argument merge; earlier folds win equal timestamps.
- A non-object envelope/rule or non-array `entries` throws `Error`; field validation remains the host's responsibility.
- No I/O or JSON serialization.

## Versioning And Publishing

Version `0.2.0` is exact-pinned by consumers. Release via branch, PR, passing checks, GitHub merge, then `notes-core-v0.2.0` on the merge commit; the tag workflow publishes it.
