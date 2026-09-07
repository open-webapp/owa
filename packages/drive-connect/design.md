# drive-connect — design

See `product-behavior.md` for user-visible behavior.

## Package

- `@open-webapp/drive-connect` v0.1.0, `"type": "module"`.
- Exports: `.` → `dist/index.js` (types `dist/index.d.ts`); `./styles.css` → `dist/styles.css`.
- Peers: `@open-webapp/drive-sync ^0.6.0`, `react ^19`.
- Build: `tsc && cp src/styles.css dist/styles.css` (stylesheet copied, never bundled into JS).
- Published `files`: `dist`, `README.md`, `design.md`, `product-behavior.md`.

## Directory structure

| Path | Role |
|------|------|
| `src/types.ts` | All public interfaces + `Connection` re-export |
| `src/statusStore.ts` | `createStatusStore`, `DISCONNECTED_STATUS` (internal) |
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

Not exported (internal): `createStatusStore`, `DISCONNECTED_STATUS`, `StatusStore`, `isTokenUsable`.

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
  getStatus(): DriveAuthStatus;
  subscribe(listener: () => void): () => void;   // returns unsubscribe
  refresh(): Promise<DriveAuthStatus>;
  connect(): Promise<Connection>;
  disconnect(): Promise<void>;
  ensureFresh(): Promise<Connection>;
  activate(): () => void;           // host-called only
}

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
  refresh: () => Promise<DriveAuthStatus>;
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
   └─ useSyncExternalStore(auth.subscribe, auth.getStatus, auth.getStatus)
```

`GoogleDriveWidget` renders one region under `.owa-drive-root`:

| Condition | Rendered |
|-----------|----------|
| `!connected && !needsReauth` | Connect button (`Connecting…` while `connecting`, disabled) |
| `connected && !needsReauth` | Status line + email span + Disconnect button (disabled while `connecting`) |
| `connected && needsReauth` | Reauth block + Reconnect button (disabled while `connecting`) |
| `error` truthy | `<p role="alert">` with message (in addition to the above) |
| `description != null` | Description block (in addition to the above) |

## State management

- `auth.ts` closure owns one `createStatusStore(DISCONNECTED_STATUS)` per handle.
- `StatusStore`: `get()`, `set(next)`, `patch(partial)`, `subscribe(fn) → unsubscribe`.
- `get()` returns a shallow-stable reference — the internal snapshot is replaced only when at least one of the 7 `DriveAuthStatus` fields differs (shallow compare), so `useSyncExternalStore` does not loop.
- `set` / `patch` notify only when the snapshot reference actually changed. Listeners are iterated over a copy, so unsubscribing during a notify pass is safe.
- `project` handle is resolved per use (`drive.project(projectId)`), never cached.
- One `connectInFlight: Promise<Connection> | null` per handle, shared by `connect()` and `ensureFresh()`.
- `wrap = beforeInteractive ?? (<T>(fn) => fn())`. Invoked once per `connect()` and once per `disconnect()`; never for `refresh()` / `getConnection()` / the cached fast path of `ensureFresh()`.
- `INTERACTIVE_TIMEOUT_MS = 10000`.

## Data model — `DriveAuthStatus` fields

| Field | Source |
|-------|--------|
| `connected` | a `Connection` exists (`conn !== null`) |
| `email` | `conn.email ?? null` |
| `expiresAt` | `conn.expiresAt ?? null` — token expiry epoch ms, or null |
| `needsReauth` | `conn.needsReauth ?? false` (from drive-sync scope-coverage check) |
| `tokenValid` | `isTokenUsable(conn, tokenBufferMs)` |
| `connecting` | interactive flow (`connect`/`disconnect`) in progress |
| `error` | message of last interactive failure, else null |

`isTokenUsable(conn: Connection | null, bufferMs: number): conn is Connection` =
`conn !== null && !conn.needsReauth && conn.expiresAt !== null && conn.expiresAt > Date.now() + bufferMs`.

## Data flows

### `refresh()` — non-interactive
- `conn = await project().getConnection()`.
- Build snapshot: `connected: conn !== null`, `email`, `expiresAt`, `needsReauth` from `conn`; `tokenValid: isTokenUsable(conn, tokenBufferMs)`; `connecting` / `error` carried over from current snapshot.
- `store.set(snapshot)`; return snapshot.
- Never wrapped by `beforeInteractive`. A null connection is a valid disconnected snapshot. A throw from `getConnection()` propagates and leaves the snapshot untouched.

### `connect()`
- If `connectInFlight` set → return it.
- `store.patch({ connecting: true, error: null })`.
- `connectInFlight = runConnect().finally(() => connectInFlight = null)`.
- `runConnect()`:
  - Race `wrap(() => project().connect())` against a 10s timeout `Error('Google auth timed out')`.
  - Falsy result → `throw new Error('No connection returned from Google Drive')`.
  - Success → `await refresh()`, `store.patch({ connecting: false, error: null })`, resolve the `Connection`.
  - Failure → `store.set({ ...DISCONNECTED_STATUS, error: messageOf(err) })`, rethrow the original value unchanged.
  - `finally` → clear the timeout timer.

### `disconnect()`
- Not routed through `connectInFlight`.
- `store.patch({ connecting: true, error: null })`.
- `await wrap(() => project().disconnect())`.
- Success → `store.set({ ...DISCONNECTED_STATUS })`.
- Failure → `store.patch({ connecting: false, error: messageOf(err) })`, rethrow; connected status left intact.

### `ensureFresh()`
- `conn = await project().getConnection()`.
- `isTokenUsable(conn, tokenBufferMs)` → return `conn` (no popup, no `beforeInteractive`, no store write).
- else → `return connect()` (shares `connectInFlight` guard and 10s timeout).

### `activate()`
- Passthrough to `drive.activate()` (drive-sync facade-level; registers the single `visibilitychange` / `pageshow` warm-up listener pair across tracked project ids). Returns drive-sync's disposer unchanged.
- Host-called only — no code in this package calls it; the widget does not call it on mount.

### `refresh` triggers (widget)
- Mount, once (`useEffect([auth])`).
- `document` `visibilitychange` when `document.visibilityState === 'visible'` (listener added/removed per `auth`).
- After the widget's own `connect()` / `disconnect()` (via `runConnect`'s internal `refresh()`; `disconnect` sets disconnected directly).
- Host-called `auth.refresh()`.
- The widget swallows `refresh()` rejections (`.catch(() => {})`) — the handle already records failures.

## Design patterns

- Host-owned drive-sync facade: the package never calls `createDriveSync`; `drive` is supplied via `DriveAuthOptions`.
- Single per-handle in-flight guard (`connectInFlight`) shared by `connect()` + `ensureFresh()` — back-to-back interactive requests fold into one flow / one Google window.
- `beforeInteractive` wraps interactive `connect` / `disconnect` only, never `refresh` / `getConnection` / the cached `ensureFresh` path; default is identity.
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
- `auth.test.ts` — `createDriveAuth` flows. `widget.test.tsx` — `GoogleDriveWidget` + `useDriveConnection`.
