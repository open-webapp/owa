# drive-connect — design

See `product-behavior.md` for user-visible behavior.

## Package

- `@open-webapp/drive-connect` v0.2.0, `"type": "module"`.
- Exports: `.` → `dist/index.js` (types `dist/index.d.ts`); `./styles.css` → `dist/styles.css`.
- Peers: `@open-webapp/drive-sync ^0.8.0`, `react ^19`.
- Build: `tsc && cp src/styles.css dist/styles.css` (stylesheet copied, never bundled into JS).
- Published `files`: `dist`, `README.md`, `design.md`, `product-behavior.md`.

## Directory structure

| Path | Role |
|------|------|
| `src/types.ts` | All public interfaces + `Connection` re-export |
| `src/statusStore.ts` | internal overlay store (`connecting`/`error`) + merged-status shallow-compare gate |
| `src/auth.ts` | `createDriveAuth` + internal `isTokenUsable`, `messageOf` |
| `src/useDriveConnection.ts` | `useDriveConnection` hook |
| `src/GoogleDriveWidget.tsx` | `GoogleDriveWidget` component |
| `src/styles.css` | Shipped stylesheet (→ `dist/styles.css`) |
| `src/index.ts` | Public entry |
| `src/__tests__/setup.ts` | vitest/jsdom setup |
| `src/__tests__/harness.ts` | `makeHarness()` — real drive-sync facade wired to `@open-webapp/drive-sync/testing` fakes |
| `src/__tests__/auth.test.ts` | `createDriveAuth` behavior |
| `src/__tests__/widget.test.tsx` | `GoogleDriveWidget` + `useDriveConnection` behavior |

## Public API (`src/index.ts`)

Values: `createDriveAuth`, `useDriveConnection`, `GoogleDriveWidget`.
Types: `DriveAuthHandle`, `DriveAuthStatus`, `DriveAuthOptions`, `GoogleDriveWidgetProps`, `DriveWidgetClassNames`, `Connection` (re-export from drive-sync).

Not exported (internal): `createOverlayStore`, `shallowEqualStatus`, `OverlayStore`, `isTokenUsable`. Also package-internal, but reachable only via the `INTERNAL_STATUS` symbol exported from `auth.ts` (not part of the public `DriveAuthHandle` type, used only by `useDriveConnection.ts`): `getMergedSnapshot`, `subscribeMerged`.

`DISCONNECTED_STATUS`/`createStatusStore` are gone — there is no longer a full-`DriveAuthStatus` store; `createOverlayStore` holds only the `{connecting, error}` overlay.

### Signatures

```ts
createDriveAuth(opts: DriveAuthOptions): DriveAuthHandle

DriveAuthOptions = {
  drive: DriveSync;                 // host-owned drive-sync facade
  projectId: string;
  tokenBufferMs?: number;           // default 300000 (5 * 60 * 1000)
  beforeInteractive?: <T>(fn: () => Promise<T>) => Promise<T>;  // default identity
}

DriveAuthHandle = {
  connect(): Promise<Connection>;
  disconnect(): Promise<void>;
  ensureFresh(): Promise<Connection>;
  activate(): () => void;           // host-called only
}
```

That is the entire public interface — `getStatus()`/`subscribe()`/`refresh()` are gone, and status is not readable off the handle at all any more. The only supported way to read live status is `useDriveConnection(auth)`; a non-React host has no equivalent on `auth` and must build its own against drive-sync's `getConnectionSync()`/`subscribeConnection()`.

```ts
DriveAuthStatus = {
  connected: boolean;
  email: string | null;
  expiresAt: number | null;
  needsReauth: boolean;
  tokenValid: boolean;
  connecting: boolean;
  error: string | null;
}

useDriveConnection(auth: DriveAuthHandle): {
  connected: boolean;
  email: string | null;
  connecting: boolean;
  error: string | null;
  needsReauth: boolean;
}

GoogleDriveWidgetProps = {
  auth: DriveAuthHandle;
  onConnected?: (connection: Connection) => void;
  onDisconnected?: () => void;
  classNames?: DriveWidgetClassNames;
  description?: ReactNode;
}

DriveWidgetClassNames = {           // all values string
  root?; status?; email?; connectButton?; disconnectButton?; reauth?; error?; description?;
}

Connection = {                      // from @open-webapp/drive-sync
  email: string;
  needsReauth: boolean;
  expiresAt: number | null;
}
```

## Component tree

```
GoogleDriveWidget(props)
└─ useDriveConnection(auth)
   └─ useSyncExternalStore(subscribeMerged, getMergedSnapshot, getMergedSnapshot)
```

`getMergedSnapshot`/`subscribeMerged` are pulled off `auth` internally by `useDriveConnection` via the private `INTERNAL_STATUS` symbol — NOT `auth.subscribe`/`auth.getStatus`, which no longer exist on `DriveAuthHandle`. `subscribeMerged` fans in `drive.project(id).subscribeConnection(...)` (drive-sync's connection-snapshot store) together with the local overlay store's `subscribe`, and on every notify from either source recomputes the merged snapshot — including `tokenValid` — before calling the React listener.

`GoogleDriveWidget` renders one region under `.owa-drive-root`:

| Condition | Rendered |
|-----------|----------|
| `!connected && !needsReauth` | Connect button (`Connecting…` while `connecting`, disabled) |
| `connected && !needsReauth` | Status line + email span + Disconnect button (disabled while `connecting`) |
| `connected && needsReauth` | Reauth block + Reconnect button (disabled while `connecting`) |
| `error` truthy | `<p role="alert">` with message (in addition to the above) |
| `description != null` | Description block (in addition to the above) |

## State management

Drive-sync is now the single source of truth for connection state — this package no longer keeps a per-handle 7-field status store.

- `auth.ts` keeps only `createOverlayStore({connecting: false, error: null})` per handle — the small local piece of state that has nothing to do with the connection itself.
- An internal (non-public) merge function, `computeMerged()`, builds a full `DriveAuthStatus` by combining `drive.project(projectId).getConnectionSync()` (connection-derived fields) with the overlay (`connecting`/`error`) and a computed `tokenValid`.
- The merged snapshot is cached (`mergedSnapshot`) and recomputed via `recomputeMerged()` **only** in two situations: on notify (either drive-sync's `subscribeConnection` or the overlay's `subscribe` fires), or once lazily on first access (`getMergedSnapshot()` when `mergedSnapshot` is still unset). A plain read of an already-computed snapshot never recomputes it — so `tokenValid`, which depends on `Date.now()`, is frozen between notifies and can go briefly stale. This is accepted given the existing token buffer (`tokenBufferMs`), which already tolerates some slack.
- The merge (`getMergedSnapshot`/`subscribeMerged`) is reachable only by `useDriveConnection`, via the private `INTERNAL_STATUS` symbol — it is never exposed as a public `getStatus`/`subscribe` method on `DriveAuthHandle`.
- `project` handle is resolved per use (`drive.project(projectId)`), never cached.
- One `connectInFlight: Promise<Connection> | null` per handle, shared by `connect()` and `ensureFresh()` — unchanged.
- `wrap = beforeInteractive ?? (<T>(fn) => fn())`. Invoked once per `connect()` and once per `disconnect()`; never for the cached fast path of `ensureFresh()` — unchanged.
- `INTERACTIVE_TIMEOUT_MS = 10000` — unchanged.

## Data model — `DriveAuthStatus` fields

`DriveAuthStatus` itself is unchanged in shape/name — still the same 7 fields — only where each field comes from has changed.

| Field | Source |
|-------|--------|
| `connected` | `drive.project(projectId).getConnectionSync() !== null` |
| `email` | from that same snapshot's `conn.email ?? null` |
| `expiresAt` | from that same snapshot's `conn.expiresAt ?? null` — token expiry epoch ms, or null |
| `needsReauth` | from that same snapshot's `conn.needsReauth ?? false` (drive-sync scope-coverage check) |
| `tokenValid` | still `isTokenUsable(conn, tokenBufferMs)`, but computed only at notify time (or lazily on first access) — frozen between notifies, not recomputed on every read |
| `connecting` | local overlay (`createOverlayStore`) |
| `error` | local overlay (`createOverlayStore`) |

`isTokenUsable(conn: Connection | null, bufferMs: number): conn is Connection` =
`conn !== null && !conn.needsReauth && conn.expiresAt !== null && conn.expiresAt > Date.now() + bufferMs`.

## Data flows

### `connect()`
- If `connectInFlight` set → return it.
- `overlay.patch({ connecting: true, error: null })`.
- `connectInFlight = runConnect().finally(() => connectInFlight = null)`.
- `runConnect()`:
  - Race `wrap(() => project().connect())` against a 10s timeout `Error('Google auth timed out')`.
  - Falsy result → `throw new Error('No connection returned from Google Drive')`.
  - Success → `overlay.patch({ connecting: false, error: null })`, resolve the `Connection`.
  - Failure → `overlay.patch({ connecting: false, error: messageOf(err) })`, rethrow the original value unchanged.
  - `finally` → clear the timeout timer.
- Connection fields (`connected`/`email`/`expiresAt`/`needsReauth`) are **not** patched here at all — they come from drive-sync's post-`connect()` snapshot re-read, which drive-sync itself `await`s before resolving `project().connect()`. So by the time `auth.connect()` resolves, `getConnectionSync()` (and therefore the merged status) is already current; there is nothing left for this package to re-fetch.

### `disconnect()`
- Not routed through `connectInFlight`.
- `overlay.patch({ connecting: true, error: null })`.
- `await wrap(() => project().disconnect())`.
- Success → `overlay.patch({ connecting: false, error: null })`.
- Failure → `overlay.patch({ connecting: false, error: messageOf(err) })`, rethrow; connected status left intact (only the overlay changed).
- Same reasoning as `connect()`: drive-sync `await`s its own snapshot re-read before `project().disconnect()` resolves, so the connection fields are already current when `auth.disconnect()` settles.

### `ensureFresh()`
- `conn = await project().getConnection()`.
- `isTokenUsable(conn, tokenBufferMs)` → return `conn` (no popup, no `beforeInteractive`, no overlay write).
- else → `return connect()` (shares `connectInFlight` guard and 10s timeout).

### `activate()`
- Passthrough to `drive.activate()` (drive-sync facade-level; registers the single `visibilitychange` / `pageshow` warm-up listener pair across tracked project ids, and starts cross-tab broadcast listening). Returns drive-sync's disposer unchanged.
- Host-called only — no code in this package calls it; the widget does not call it on mount.

### Status subscription
- There is no polling, no mount re-read, and no standalone `auth.subscribe()`/`auth.refresh()` any more.
- Status is push-updated: an internal (not public) `subscribeMerged` helper — reachable only through `useDriveConnection`, via the private `INTERNAL_STATUS` symbol on `auth` — fans in `drive.project(projectId).subscribeConnection(...)` with the local overlay's `subscribe`. Either source firing triggers `recomputeMerged()` followed by the React listener.
- This means the widget picks up: this tab's own `connect()`/`disconnect()` (once drive-sync's awaited re-read lands), drive-sync's background warm-up, and cross-tab `logout`/`token` broadcasts — all without any code in this package initiating a re-read itself.

## Design patterns

- Host-owned drive-sync facade: the package never calls `createDriveSync`; `drive` is supplied via `DriveAuthOptions`.
- Connection state is never cached in this package — the single source of truth is drive-sync (`getConnectionSync()`/`subscribeConnection()`); this package layers only the small `{connecting, error}` overlay on top.
- Status is a React-hook-only API in this package now — `DriveAuthHandle` itself exposes no way to read or subscribe to status (no `getStatus`/`subscribe`/`refresh`). Non-React hosts must build their own equivalent directly against drive-sync's `getConnectionSync()`/`subscribeConnection()`.
- Single per-handle in-flight guard (`connectInFlight`) shared by `connect()` + `ensureFresh()` — back-to-back interactive requests fold into one flow / one Google window.
- `beforeInteractive` wraps interactive `connect` / `disconnect` only, never `getConnection` / the cached `ensureFresh` path; default is identity.
- CSS custom-property theming: `--owa-drive-*` with built-in fallbacks; no shipped `:root` block.
- `classNames` bag prepends the host class and keeps the `owa-drive-*` class: `host ? \`${host} ${pkg}\` : pkg`.
- Popup-closed recovery is delegated to drive-sync, not reimplemented here.
- Errors render inline (`role="alert"`); never `window.alert`.

## Styling architecture

- `src/styles.css` is copied to `dist/styles.css` by the build (not bundled into JS). Host imports `@open-webapp/drive-connect/styles.css`.
- Classes (1:1 with the component): `owa-drive-root`, `owa-drive-connect`, `owa-drive-status`, `owa-drive-email`, `owa-drive-disconnect`, `owa-drive-reauth`, `owa-drive-error`, `owa-drive-description`.
- Tokens (with fallbacks): `--owa-drive-fg`, `--owa-drive-muted`, `--owa-drive-accent`, `--owa-drive-accent-fg`, `--owa-drive-danger`, `--owa-drive-gap`, `--owa-drive-radius`, `--owa-drive-font`.

## Tests

- vitest + jsdom. `makeHarness()` wires the real `@open-webapp/drive-sync` facade to `@open-webapp/drive-sync/testing` fakes (`createGisFake`, `createDriveFake`); a host `fetch` shim answers the userinfo and revoke endpoints and forwards the rest to the Drive fake.
- `auth.test.ts` — `createDriveAuth` flows; reads status via a `useDriveConnection` test render or `drive.project(id).getConnectionSync()` directly, not `auth.getStatus()`/`auth.subscribe()` (removed). `widget.test.tsx` — `GoogleDriveWidget` + `useDriveConnection`; the lifecycle suite now asserts subscription-driven re-render (a drive-sync snapshot or overlay change causing a re-render) rather than counting `auth.refresh()` calls.
