# @open-webapp/calendar SPEC

## Scope

Read-only Google Calendar sync for N accounts ("sources"), local encrypted cache via host adapters, React presentation. No OAuth: the host provides `getToken(sourceId)`.

## Public surface

Package exports: `.`, `./testing`, `./styles.css`.

`.` re-exports: types (`Source`, `RsvpStatus`, `CalendarEvent`, `CalendarEventDateTime`, `CalendarInfo`, `ParseContext`), events helpers (`DEFAULT_RSVP_STATUSES`, `reconcileSelectedCalendarIds`, `filterCalendarsByName`, `getCalendarEventKey`, `summarizeCalendarSelection`, `isAllDay`, `getRollingWindow`, `filterByRsvp`, `getOrganizerLabel`, `isEventCurrent`, `findNextUpcomingEvent`, `groupByDay`, `formatDayHeader`, `DayGroup`, `deriveSelfResponseStatus`, `extractJoinUrl`, `parseEvent`, `parseEvents`), storage types (`SyncState`, `StorageRow`, `StorageAdapter`, `CryptoAdapter`), fetch (`CalendarFetchError`, `fetchCalendarList`, `fetchEvents`, `EventsPage`, `RefreshDeferredError`, `isRefreshDeferredError`), `syncCalendar`, `reconcileSelection`, `applyChanges`, controller (`createCalendarController`, `CalendarController`, `CalendarControllerOptions`, `CalendarControllerState`, `SourceStatus`), UI (`CalendarPane`, `CalendarPaneProps`, `RsvpSelection`, `CalendarSelector`).

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

- `CalendarPane` gains `connected?` (default `sources.length > 0`), `needsReauth?` (default: all sources `needs-scope`), `onConnect?`, `onReconnect?`.
- `emptyState` replaces the built-in not-connected block; `sourceNotice` renders per `needs-scope` source.
- Multi-source (2+ sources): events colored per source, email shown.
- Selector keeps at least one calendar selected; "Clear" resets to primary.
- Event popup opens via `window.open(url, popupName)` falling back to `_blank`.
- Built-in copy is fixed: see README "Built-in copy".

## Styling

`./styles.css` standalone, `prefers-color-scheme` dark variants. Variables: `--calendar-footer-height`, `--chip-row-height` (optional host overrides), `--rsvp-bar` (internal). No required host variables.

## Versioning

Independent semver; tag `calendar-v<version>` publishes. Breaking changes to exports, row shapes, selection semantics or status semantics require a major (0.x: minor) bump. 0.2.0 is a BREAKING minor (selection semantics, cache/storage row fields, pane behavior); 0.1.0 rows still read.
