# @open-webapp/calendar design

## Layers

- `core/`: framework-free. `types`, `events` (pure helpers/parsing), `fetch` (Google REST, `CalendarFetchError`, `RefreshDeferredError`), `sync` (per-calendar full/incremental), `reconcile` (selection, change application), `storage` (adapter types), `controller`.
- `react/`: `CalendarPane`, `CalendarSelector`, `styles.css`. Consumes the controller via `subscribe`/`getEvents`/`getState`. Optional `theme?: 'system' | 'light' | 'dark'` is presentation-only, defaulting to system; the pane forwards it to every internal selector.
- `testing/`: shared fixtures and the storage contract, published as `./testing`.

## Decisions

- All four RSVP chips independently toggle current host-supplied membership via the same cloning helper. O is pressed iff needsAction is selected, including defaults/mixed sets; unanswered events follow membership within calendar/window filters. Defaults remain accepted/tentative/needsAction. Removing the last status returns defaults: O-only -> O leaves O pressed. Explicit empty host sets stay empty without callbacks. No previous RSVP selection is saved/restored. This breaking 0.8.0 behavior supersedes the historical 0.3.0 exclusive shortcut.
- Ribbon labels use a ribbon-local absolute window: top = max(ribbon top, viewport top, measured chip bottom, that day's header bottom); bottom = min(ribbon bottom, viewport bottom), with height clamped to zero. The shared chip/scroll ResizeObserver observes viewport/chips/headers/ribbons, never the absolute window. Scroll and rendered-content/date/theme changes update geometry; cleanup disconnects the observer and removes the listener. This handles empty Today before an event day and short ribbons without fixed header-height assumptions or public geometry state.

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
- Full semantic palette resets and scoped native-control `color-scheme` at each root isolate nested and adjacent instances. A standalone system selector follows the OS even under an opposite-theme pane. Existing palette literals and functional contracts are preserved; trigger geometry and token application have the approved visual-only exception below.
- Shared `GroupedCalendarSelector` renders `.calendar-selector-trigger` for both the footer and exported `CalendarSelector`. The approved exception replaces native trigger sizing with border-box inline-flex, centered alignment, an 8px gap, 36px minimum height, 8px 12px padding, 6px radius, 1px solid control border, inherited font and pointer cursor. A nonshrinking 12px currentColor SVG chevron is decorative (`aria-hidden`, nonfocusable); the label ellipsizes within available width while the accessible name stays complete. Resting surface/text, hover surface and a 2px focus-visible outline with 2px offset use existing scoped theme tokens. The default 64px footer and 6px upward-dropdown clearance remain intact; trigger-dependent dropdown placement follows the larger trigger. Props, handlers, combobox relationships, selection, search, keyboard traversal, native activation and focus return are unchanged.
- Prop transitions, including back to system/undefined, preserve mounted interaction state (open dropdown, query, focus, active option, calendar selection and current RSVP selection); they do not cause controller refreshes or selection callbacks. No global classes, document/body mutations, shared theme context or controller/storage fields are needed.
- Host owns theme-picker UI, preference persistence and explicit styling for custom slots (`emptyState`, `sourceNotice`, `renderEventAction`); built-in palette rules do not broadly restyle slot descendants.
- Visual-only 0.8.1 restyle: events render as 12px-radius bordered cards with a tinted 14px RSVP glyph instead of a right-edge status bar; RSVP filters share one 12px-radius group and Today remains a separate text button outside it. The final prototype palette uses filter-chip tokens (`chip-group-*`, `chip-active-background`, `chip-selected-ring`, `chip-icon-*`, `chip-badge-*`, `today-*`), `card-*` and per-status `status-*-{text,background,border}` tokens. The independent membership toggles, host-owned selection and measured ribbon windows from 0.8.0 remain unchanged.
