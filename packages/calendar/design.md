# @open-webapp/calendar design

## Layers

- `core/`: framework-free. `types`, `events` (pure helpers/parsing), `fetch` (Google REST + `CalendarFetchError`), `sync` (per-calendar full/incremental), `reconcile` (selection, change application), `storage` (adapter types), `controller`.
- `react/`: `CalendarPane`, `CalendarSelector`, `styles.css`. Consumes the controller via `subscribe`/`getEvents`.
- `testing/`: shared fixtures and the storage contract, published as `./testing`.

## Decisions

- Host owns tokens, storage and encryption: the package has no OAuth, IndexedDB or crypto dependency, so any app can adopt it.
- Controller state is a per-source map; a single `publish()` rebuilds immutable snapshots (events, statuses) for `useSyncExternalStore`-style consumption.
- Incremental sync via syncToken minimizes traffic; the 30-day window applies only to full syncs, and 410 falls back to one.
- Network errors keep the prior status so offline use shows cached data without error banners.
- Storage row stays compatible with legacy notesdiary rows (plain or encrypted); the contract harness locks that.
- `vitest` is an optional peer so non-test consumers install nothing extra.
- CSS shipped as a copied file (`tsc && cp`), with no host variables required.
