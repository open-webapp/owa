# @open-webapp/calendar SPEC

## Scope

Read-only Google Calendar sync for N accounts ("sources"), local encrypted cache via host adapters, React presentation. No OAuth: the host provides `getToken(sourceId)`.

## Public surface

Package exports: `.`, `./testing`, `./styles.css`.

`.` re-exports: types (`Source`, `RsvpStatus`, `CalendarEvent`, `CalendarEventDateTime`, `CalendarInfo`, `ParseContext`), events helpers (`DEFAULT_RSVP_STATUSES`, `reconcileSelectedCalendarIds`, `filterCalendarsByName`, `getCalendarEventKey`, `summarizeCalendarSelection`, `isAllDay`, `getRollingWindow`, `filterByRsvp`, `getOrganizerLabel`, `isEventCurrent`, `findNextUpcomingEvent`, `groupByDay`, `formatDayHeader`, `formatRibbonLabel`, `DayGroup`, `deriveSelfResponseStatus`, `extractJoinUrl`, `parseEvent`, `parseEvents`), storage types (`SyncState`, `StorageRow`, `StorageAdapter`, `CryptoAdapter`), fetch (`CalendarFetchError`, `fetchCalendarList`, `fetchEvents`, `EventsPage`, `RefreshDeferredError`, `isRefreshDeferredError`), `syncCalendar`, `reconcileSelection`, `applyChanges`, controller (`createCalendarController`, `CalendarController`, `CalendarControllerOptions`, `CalendarControllerState`, `SourceStatus`), UI (`CalendarPane`, `CalendarPaneProps`, `RsvpSelection`, `CalendarSelector`).

`./testing`: `runStorageAdapterContract`, `StorageContractHarness`, `LEGACY_EVENT`, `createMemoryStorage`, `identityCrypto`, `installFakeFetch`/`FakeReply`. Requires optional peer `vitest`.

## Controller invariants

1. `refresh()` and `hydrate()` never reject. Each source is refreshed independently and concurrently.
2. `hydrate()` loads stored rows and publishes cached events before any network call; an offline refresh keeps the cache.
3. `getEvents()` is concatenation of per-source events in `sources` order, filtered at read time (selected calendars only; end strictly after now-30d; start strictly before now+30d). Reference changes only on publish.
4. Persistence is best effort; failure never affects in-memory state.
5. Rows: `events` and `syncState` encrypted JSON strings; `selectedIds` plain. Reads accept plain legacy values (0.1.0 rows included); corrupt/undecryptable data yields empty state.
6. Selection: stored selection filtered to existing calendars on refresh; if empty, primary (else first). Primary is not forced.
7. `setSelectedIds(id, ids)` ignores an empty list (at least one calendar stays selected), persists, notifies, and runs a pass for newly added calendars. It does not drop events or tokens of deselected calendars; they are retained and hidden by the read-time filter.
8. `clearSelectedIds(id)` sets the selection to the primary calendar (else first).
9. Default selection before any refresh is primary.
10. Pruning: on refresh, stored events whose end is strictly before now-30d are removed.

## Deferred refresh

- `RefreshDeferredError`, or any error with `deferred: true`, marks a pass as deferred (`isRefreshDeferredError`).
- A deferred pass is quiet: no status change, no error flag, no immediate retry. `getState().deferred` is `true`.
- `retryDeferred()` re-runs a pass.

## getState

`getState()` returns `{ loading, error, deferred, lastSyncAt }`:

- `loading`: a pass is in flight.
- `error`: true only when every selected calendar (across sources) errored and `getEvents()` is empty.
- `deferred`: last pass was deferred.
- `lastSyncAt`: max per-source ms epoch of the last pass, or `null`.

## sourceStatus

| Event | Status |
| --- | --- |
| successful refresh (or some calendars succeed, none with scope error) | `ok` |
| 403 containing `insufficientPermissions` | `needs-scope` |
| 401, other 403, other HTTP, parse error, unexpected exception | `error` (when all targeted calendars failed) |
| network failure | unchanged (cached events retained) |
| deferred pass | unchanged |

Initial: `ok` for every source.

## Sync

- Window: `getRollingWindow(now)` = now-30d .. now+30d, ISO timestamps; API times sent without milliseconds.
- Full sync when: no `syncToken`, no `lastFullSyncAt` for the calendar, or `lastFullSyncAt` older than 24h. Uses `singleEvents=true`, `timeMin/timeMax`, `maxResults=250`, paginated; `nextSyncToken` and `lastFullSyncAt` stored per calendarId.
- Incremental otherwise: `syncToken` only (no time params); changes applied by event id; cancelled removed.
- 410 (`CalendarFetchError.kind === 'gone'`): fall back to full windowed sync.
- A failed calendar is retried once immediately (deferred errors excluded). Failure of one calendar keeps its cached events and token and does not affect other calendars or sources.
- `CalendarFetchError.kind`: `network | auth | scope | gone | http`.

## Event key

`getCalendarEventKey(event)` = `${sourceId}:${calendarId}:${eventId}` (e.g. `src1:calA:ev1`). This is the one intentional divergence from notesdiary (`calA:ev1`), kept by decision for multi-source.

## Adapter contract

`StorageAdapter` and `CryptoAdapter` as in README. `runStorageAdapterContract(factory)` is the normative test suite; a host adapter must pass it. Harness fields: `storage`, `crypto`, optional `seedRaw`, `wrongKeyCrypto`, `encryptedFixture`, `corruptRow`.

## UI contract

`CalendarPane` and `CalendarSelector` props as in README.

- All four RSVP chips independently toggle current supplied membership. O is pressed iff needsAction is selected, including defaults/mixed sets; unanswered events follow membership within calendar/window filters. Defaults remain accepted/tentative/needsAction. Removing the last status returns defaults (O-only -> O leaves O pressed). Explicit empty host sets remain empty without normalization/callbacks on rerender. No previous RSVP selection is saved/restored. This breaking 0.8.0 contract supersedes the historical 0.3.0 exclusive shortcut.
- Ribbon labels center in the actual intersection: top = max(ribbon top, viewport top, measured chip bottom, that day's header bottom); bottom = min(ribbon bottom, viewport bottom). Empty intersections have zero height. This covers empty Today before an event day and short ribbons, updating on scroll, resize, rendered-content and mounted theme changes.

- Both accept `theme?: 'system' | 'light' | 'dark'`; omitted/`undefined` means `'system'`. System follows OS/browser color-scheme changes live; explicit modes ignore OS changes.
- A mounted prop change applies without remounting or resetting dropdown open/query/focus/keyboard-active state, calendar selection or current RSVP selection, and without theme-induced callbacks or controller refreshes.
- Every pane return state uses the requested mode, forwarded to every internal selector. Standalone selectors resolve their own mode, including system inside an opposite-theme ancestor. Adjacent/nested roots remain independent.
- Theme-picker UI, preference persistence and custom slot styling belong to the host; theme is not controller/storage state.

- `CalendarPane` gains `connected?` (default `sources.length > 0`), `needsReauth?` (default: all sources `needs-scope`), `onConnect?`, `onReconnect?`.
- `emptyState` replaces the built-in not-connected block; `sourceNotice` renders per `needs-scope` source.
- Multi-source (2+ sources): events colored per source, email shown.
- CalendarPane has one footer combobox opening a shared searchable dropdown, grouped under account headings for multiple sources. Clear resets only its account to primary (else first); filtered Select all adds only that account's matches, retaining existing selections. Each account keeps its last selected calendar, including a non-primary selection. Calendar IDs shared across accounts remain independent.
- Exported standalone CalendarSelector retains its single-list props and behavior, including filtered Select all, Clear and last-selection protection.
- Event popup opens via `window.open(url, popupName)` falling back to `_blank`.
- Built-in copy is fixed: see README "Built-in copy".

- Each day group has a 16px `aria-hidden` vertical ribbon left of its events showing a rotated `Mmm D` label (no year, no Today/Tomorrow; `formatRibbonLabel`); ribbons alternate between two tones by day parity (`data-parity="even|odd"`, days since 1970 of the date key mod 2), stable across scroll, filter and month boundaries. Today is not flagged on the ribbon. "Today" is the browser-local date. The RSVP bar is a 3px right border on event rows. The sticky day header is unchanged.

## Styling

`./styles.css` is standalone. Each `.calendar-pane` and `.calendar-selector` root has `data-calendar-theme` and resets the full semantic palette, including scoped native-control `color-scheme`. Light defaults, explicit-dark overrides and system-only dark media rules preserve the existing palette while preventing opposite-theme ancestor leakage. No document/body attributes or global theme state are changed. Built-in prompts, errors, loading/empty states, events, RSVP chips/badge, footer and selector controls are covered; hosts style their own `emptyState`, `sourceNotice` and `renderEventAction` content. Variables: `--calendar-footer-height`, `--chip-row-height` (optional host overrides), `--calendar-day-ribbon-a` / `--calendar-day-ribbon-b` (alternating day ribbon colours by parity), `--rsvp-bar` (internal). Ribbon labels use measured bounds instead of the former `--calendar-day-header-height` offset. No required host variables.

## Versioning

Independent semver; tag `calendar-v<version>` publishes. Breaking changes to exports, row shapes, selection semantics or status semantics require a major (0.x: minor) bump. 0.2.0 is a BREAKING minor (selection semantics, cache/storage row fields, pane behavior); 0.1.0 rows still read.

0.4.0 is a BREAKING pre-1.0 minor for the requested observable pane UI change from per-account footer triggers to one grouped selector; standalone selector compatibility is preserved.

0.5.0 is an additive minor for optional component themes, with no migration or breaking behavior change. The default remains OS-selected styling.
