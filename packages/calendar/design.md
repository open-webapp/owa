# @open-webapp/calendar design

## Layers

- `core/`: framework-free. `types`, `events` (pure helpers/parsing), `fetch` (Google REST, `CalendarFetchError`, `RefreshDeferredError`), `sync` (per-calendar full/incremental), `reconcile` (selection, change application), `storage` (adapter types), `controller`.
- `react/`: `CalendarPane`, `CalendarSelector`, `styles.css`. Consumes the controller via `subscribe`/`getEvents`/`getState`. Optional `theme?: 'system' | 'light' | 'dark'` is presentation-only, defaulting to system; the pane forwards it to every internal selector.
- `testing/`: shared fixtures and the storage contract, published as `./testing`.

## Decisions

- Host owns tokens, storage and encryption: the package has no OAuth, IndexedDB or crypto dependency, so any app can adopt it.
- Controller state is a per-source map; a single `publish()` rebuilds immutable snapshots (events, statuses) for `useSyncExternalStore`-style consumption.
- Cache-first: `hydrate()` publishes stored events before any network call, so the pane is useful immediately and offline.
- Incremental sync via syncToken minimizes traffic; a full windowed sync runs when there is no token, no `lastFullSyncAt`, or the last full sync is over 24h old. 410 falls back to a full sync.
- Selection is not forced to primary. The stored selection is honored when it still exists; otherwise primary (else first). At least one calendar always stays selected.
- CalendarPane supplies account-local calendars, selections and controller writes to one internal grouped footer selector. Open/search state and keyboard traversal are shared; option identity includes account and calendar IDs. Clear, filtered Select all (retaining existing selections) and last-selected protection stay account-local. Exported CalendarSelector delegates as a single group with compatible props and behavior.
- Deselecting a calendar retains its cached events and sync tokens; the read-time filter hides them. Re-selecting shows them at once.
- Windowing happens twice: refresh prunes events that ended before now-30d; reads keep only events overlapping now-30d .. now+30d.
- Per-calendar isolation: one failing calendar keeps its cache and token without affecting others. The error flag is raised only when every selected calendar errored and nothing is cached.
- Deferred passes are quiet (no status or error change); the host drives `retryDeferred()`.
- Network errors keep the prior status so offline use shows cached data without error banners.
- Storage row stays compatible with legacy notesdiary rows (plain or encrypted) and 0.1.0 rows; the contract harness locks that.
- Event identity is multi-source (`sourceId:calendarId:eventId`); the one intentional divergence from notesdiary's `calendarId:eventId`.
- `vitest` is an optional peer so non-test consumers install nothing extra.
- CSS shipped as a copied file (`tsc && cp`), with no host variables required.
- CSS-native OS tracking: each pane/selector root carries `data-calendar-theme`; light defaults, explicit-dark overrides and system-only `prefers-color-scheme` media rules update mounted system instances live without a JavaScript media listener. Explicit modes ignore OS changes.
- Full semantic palette resets and scoped native-control `color-scheme` at each root isolate nested and adjacent instances. A standalone system selector follows the OS even under an opposite-theme pane. Existing palette literals, geometry and functional contracts are preserved.
- Prop transitions, including back to system/undefined, preserve mounted interaction state (open dropdown, query, focus, active option, selection and saved RSVP state); they do not cause controller refreshes or selection callbacks. No global classes, document/body mutations, shared theme context or controller/storage fields are needed.
- Host owns theme-picker UI, preference persistence and explicit styling for custom slots (`emptyState`, `sourceNotice`, `renderEventAction`); built-in palette rules do not broadly restyle slot descendants.
