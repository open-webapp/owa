# @open-webapp/calendar SPEC

## Scope

Read-only Google Calendar sync for N accounts ("sources"), local encrypted cache via host adapters, React presentation. No OAuth: the host provides `getToken(sourceId)`.

## Public surface

Package exports: `.`, `./testing`, `./styles.css`.

`.` re-exports: types (`Source`, `RsvpStatus`, `CalendarEvent`, `CalendarEventDateTime`, `CalendarEventAttendee`, `CalendarInfo`, `ParseContext`), events helpers (`DEFAULT_RSVP_STATUSES`, `reconcileSelectedCalendarIds`, `filterCalendarsByName`, `getCalendarEventKey`, `summarizeCalendarSelection`, `isAllDay`, `getRollingWindow`, `filterByRsvp`, `getOrganizerLabel`, `isEventCurrent`, `findNextUpcomingEvent`, `groupByDay`, `formatDayHeader`, `formatRibbonLabel`, `DayGroup`, `deriveSelfResponseStatus`, `extractJoinUrl`, `parseEvent`, `parseEvents`), storage types (`SyncState`, `StorageRow`, `StorageAdapter`, `CryptoAdapter`), fetch (`CalendarFetchError`, `fetchCalendarList`, `fetchEvents`, `EventsPage`, `RefreshDeferredError`, `isRefreshDeferredError`), `syncCalendar`, `reconcileSelection`, `applyChanges`, controller (`createCalendarController`, `CalendarController`, `CalendarControllerOptions`, `CalendarControllerState`, `SourceStatus`), UI (`CalendarPane`, `CalendarPaneProps`, `RsvpSelection`, `CalendarSelector`).

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

- Accepted, Maybe and Declined independently toggle current supplied membership. Unaccepted (O) is exclusive: selecting it enters O mode, and clearing it restores an internal non-persisted saved selection. Accepted, Maybe or Declined clicks exit O mode and update that independent membership. O is pressed iff needsAction is selected; unanswered events follow that membership within calendar/window filters. Defaults are accepted/tentative. Removing the last independent status returns those defaults. Explicit empty or other non-conforming host sets remain unnormalized, without callbacks on rerender.
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
- Pane selector geometry is a breaking visual contract in 0.10.0: its upward dropdown is trigger-left aligned, constrained to the pane's 16px horizontal content inset, and may shrink below its normal 220px minimum when that inset requires it (320px remains the normal maximum). While open, the full popup is limited to the nearest pane/viewport intersection above the trigger after the preserved 6px clearance; fixed controls remain reachable and the listbox shrinks and scrolls, retaining its 240px cap when space permits. Open geometry updates for pane/root and window resize, scrolling, query/group/theme layout changes, and cleans up on close/unmount. This does not change pane root height, footer allocation, public props, callbacks, selection, data, or standalone placement/sizing.
- Plain left click on an event title opens an in-pane event details overlay (0.13.0): a bottom sheet with `role="dialog"` and `aria-modal="true"`, showing time, calendar, organizer, Join and RSVP, location, plain-text description, and attendees (max 10, then "+N more"). It has an "Open in Google Calendar" link (shown only when `htmlLink` is present). Escape, the X button and backdrop clicks close it. Focus is trapped while open and returns to the title on close. There is no opt-out prop.
- The `popupName` window (`window.open(htmlLink, popupName)`, falling back to `_blank`) opens only from the overlay's link. Modified clicks (ctrl/cmd/shift/alt/middle) on a title keep native new-tab behavior. Events without `htmlLink` open the overlay only.
- Timed meeting headers show time on the left and a right-aligned `[Join] [RSVP glyph]` pair with a 4px gap, followed by title and organizer. Join is shown iff `joinUrl` is truthy and retains its URL, `_blank`, `noopener noreferrer` and click propagation stop. Without Join, the RSVP glyph stays right aligned. The pair stays together when the header wraps on narrow layouts.
- Built-in copy is fixed: see README "Built-in copy".

- Each day group has a 16px `aria-hidden` vertical ribbon left of its events showing a rotated `Mmm D` label (no year, no Today/Tomorrow; `formatRibbonLabel`); ribbons alternate between two tones by day parity (`data-parity="even|odd"`, days since 1970 of the date key mod 2), stable across scroll, filter and month boundaries. Today is not flagged on the ribbon. "Today" is the browser-local date. The RSVP bar is a 3px right border on event rows. Sticky day headers show `Today · {weekday}`, `Tomorrow · {weekday}`, otherwise `{weekday}` using the date key's full English weekday without timezone shifts or a year suffix. Tomorrow recognition crosses month/year boundaries. Header layout and vertical ribbon styling are unchanged.

## Styling

Join uses exactly the RSVP glyph's status foreground, background and border for accepted/tentative/needsAction/declined in light, dark and system modes. Both have a compact 24px outer height, 1px solid border and 4px radius; Join has intrinsic text-fitting width and 8px horizontal padding. Hover underlines Join without changing its status palette; keyboard focus shows a 2px theme-focus outline with 2px offset.

The event details overlay uses `.calendar-event-details` (full-pane backdrop) and `.calendar-event-details-sheet` (bottom sheet, max 80% of pane height, internal scroll). Both use the pane's palette tokens and follow its `theme`.

`./styles.css` is standalone. Each `.calendar-pane` and `.calendar-selector` root has `data-calendar-theme` and resets the full semantic palette, including scoped native-control `color-scheme`. Light defaults, explicit-dark overrides and system-only dark media rules preserve the existing palette while preventing opposite-theme ancestor leakage. No document/body attributes or global theme state are changed. Built-in prompts, errors, loading/empty states, events, RSVP chips/badge, footer and selector controls are covered; hosts style their own `emptyState`, `sourceNotice` and `renderEventAction` content. Variables: `--calendar-footer-height`, `--chip-row-height` (optional host overrides), `--calendar-day-ribbon-a` / `--calendar-day-ribbon-b` (alternating day ribbon colours by parity), `--rsvp-bar` (internal). Ribbon labels use measured bounds instead of the former `--calendar-day-header-height` offset. No required host variables.

The selector-trigger exception retains its padded, rounded 36px-minimum trigger, decorative 12px chevron, themed surface/hover/keyboard focus, full accessible name with visual ellipsis, default 64px footer and 6px upward-dropdown clearance. The 0.10.0 pane-only popup correction replaces the older fixed right-alignment/minimum-width geometry with the approved trigger-left, pane-inset, available-height behavior above; standalone geometry is unchanged.

The user-approved action-only visual exception applies to `.calendar-selector-actions > button` (Done, Select all and Clear), in standalone and grouped footer selectors. Resting background is transparent, border is zero, shadow is none, font is inherited, color uses `--calendar-selector-text` and cursor is pointer. Hover uses `--calendar-hover`; pointer focus has no decorative outline, and keyboard `:focus-visible` uses a 2px solid `--calendar-focus` outline with 2px offset. Action padding, row flex layout and 8px gap/top/bottom margins, footer/dropdown geometry, trigger/search/option styling and other native-control defaults remain unchanged. Selection semantics, account isolation, callbacks, keyboard behavior and Done/Escape focus return are preserved.

## Versioning

Independent semver; tag `calendar-v<version>` publishes. Approved changes to frozen observable visual contracts also require a breaking pre-1.0 minor bump.

Independent semver; tag `calendar-v<version>` publishes. Breaking changes to exports, row shapes, selection semantics or status semantics require a major (0.x: minor) bump. 0.2.0 is a BREAKING minor (selection semantics, cache/storage row fields, pane behavior); 0.1.0 rows still read.

0.4.0 is a BREAKING pre-1.0 minor for the requested observable pane UI change from per-account footer triggers to one grouped selector; standalone selector compatibility is preserved.

0.5.0 is an additive minor for optional component themes, with no migration or breaking behavior change. The default remains OS-selected styling.

0.9.0 is a BREAKING pre-1.0 minor for the user-approved replacement of frozen native dropdown-action appearance with flat themed Done, Select all and Clear. Other visual, interaction, API and storage contracts remain intact; no data migration is required.

0.13.0 is a BREAKING pre-1.0 minor. Title clicks open the in-pane event details overlay instead of the `popupName` window, which is now reached only through the overlay's link. `CalendarEvent` gains optional `location`, `description` and `attendees` (`CalendarEventAttendee`), so existing rows still read. No storage migration is required.

0.10.0 is a BREAKING pre-1.0 minor for the user-approved CalendarPane selector-popup geometry correction: trigger-left placement, pane-relative adaptive width and pane/viewport-relative available height replace the prior fixed right-aligned/minimum-width behavior. The 64px default footer, 36px-minimum trigger, 6px upward clearance, standalone selector geometry, public API, selection/data contracts and storage schema remain unchanged; no migration is required.
