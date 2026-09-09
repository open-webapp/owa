# Plan: drive-connect — Phase 1 (build the package)

## Goal
Two apps (portfolio, notesdiary) each hand-roll the same Google Drive connect/disconnect logic: token-runway check, single in-flight guard so two callers cannot open two auth popups, 10s timeout race, connected/connecting/needsReauth UI, disconnect link. Same bugs, two copies. Build ONE package `@open-webapp/drive-connect` that owns ALL Drive AUTH and NOTHING about synced content. Phase 1 = write it, test it, document it, publish it. No app migrates in this phase. Phase 2 (`drive-connect-p2-notesdiary`) and Phase 3 (`drive-connect-p3-portfolio`) are separate plans by others — do not touch those apps here.

## Scope
**In scope:**
- New package `packages/drive-connect/` in the owa monorepo, version `0.1.0`.
- Plain (non-React) handle `createDriveAuth({ drive, projectId, tokenBufferMs?, beforeInteractive? })`.
- React hook `useDriveConnection(auth)` + React component `<GoogleDriveWidget />`.
- Package-owned stylesheet `styles.css` with `owa-drive-*` classes and `--owa-drive-*` custom-property theming.
- vitest + jsdom + @testing-library/react test suite driving the real `createDriveSync` facade through `@open-webapp/drive-sync/testing` fakes.
- Reference docs `design.md` + `product-behavior.md` in package root, plus `README.md`.
- Publish wiring: new `drive-connect-v*` tag trigger + job in `.github/workflows/publish.yml`, new auto-tagging rule in `CLAUDE.md`.

**Out of scope:**
- Any change to `packages/drive-sync` or `packages/project-sync`.
- Any change to portfolio or notesdiary (phases 2 and 3).
- Codec, encryption, picker, restore, conflict resolution, `SyncDocument`, backup-file lookup — package owns none of it.
- Calling `createDriveSync` inside the package. Host constructs the facade, passes it in.
- Subscribing to drive-sync connection-change events (no such API; do not add one this phase).
- React context / provider. Handle must work from plain module functions.
- `window.alert` anywhere in the package.

## Resolved decisions
1. Package name `@open-webapp/drive-connect`, version `0.1.0`, own `drive-connect-v<version>` git tag pushed to trigger the publish workflow (matches owa `CLAUDE.md` convention for the other two packages).
2. `react` is a **peerDependency** (`^19`), NOT optional (unlike project-sync, whose react peer is optional — this package's whole point is UI). `@open-webapp/drive-sync` is also a peerDependency (`^0.6.0`).
   > Note (non-blocking): drive-sync is now `0.7.0` (adds `thumbnailLink` / image dimensions to `files.list()`); when this plan is executed, bump the peer range to `^0.7.0` (or `>=0.6.0`). Does not block this phase.
3. Package owns ALL Drive auth, NOTHING about content.
4. Host creates the drive-sync facade via `createDriveSync(...)` and passes it in as `drive`. One facade instance = one token cache. Package never calls `createDriveSync`.
5. Single entry point `.` plus a `./styles.css` export. No `./react` subpath — hook + component live in the main entry (react is a hard peer anyway).
6. `createDriveAuth(opts)` returns a plain object handle: `getStatus()`, `connect()`, `disconnect()`, `ensureFresh()`, `refresh()`, `subscribe(fn)`, `activate()`.
7. Handle owns: the subscribable connection-status store, the SINGLE instance-level `connectInFlight` guard, and an `activate()` passthrough to `drive.activate()`.
8. `ensureFresh()` ports portfolio's `ensureFreshConnection` exactly: read `drive.project(projectId).getConnection()`; if `isTokenUsable(conn)` return it as-is; else interactive connect, coalesced through the SAME in-flight promise the widget's Connect button uses.
9. `isTokenUsable(conn)` = `conn !== null && !conn.needsReauth && conn.expiresAt !== null && conn.expiresAt > Date.now() + tokenBufferMs`. Ported verbatim from `portfolio/src/lib/drive.ts`.
10. `tokenBufferMs` defaults to `5 * 60 * 1000`.
11. `beforeInteractive?: <T>(fn: () => Promise<T>) => Promise<T>` wraps interactive `connect` and `disconnect` ONLY. Never wraps `getConnection()` / `refresh()` / the cached-token fast path of `ensureFresh()`. Notesdiary will pass `withReloadSuppressed`; portfolio passes nothing. Default = identity (`fn => fn()`).
12. Interactive connect races a 10s timeout (ported from `portfolio/src/App.tsx` `handleConnect`). Timeout or failure => status cleared to disconnected, error surfaced.
13. Errors render INLINE inside the widget in an element with `role="alert"`. Package MUST NOT call `window.alert()` anywhere — an explicit test asserts this.
14. Widget emits `onConnected(connection: Connection)` and `onDisconnected()` so hosts do their own content work (portfolio looks up its backup file id). Package does zero content lookups.
15. Four widget states, all required day one:
    - not connected → "Connect Google Drive" button
    - connecting → same button, disabled, label "Connecting…"
    - connected → "Connected as {email}" + Disconnect
    - connected && needsReauth → "Reconnect to restore sync" warning + "Reconnect" button
16. Disconnect is a real `<button>` styled as a text link (`background:none;border:0;padding:0;cursor:pointer;text-decoration:underline`), NOT a `<span onClick>` (portfolio's current bug — unfocusable, no keyboard activation).
17. Package SHIPS ITS OWN CSS: `owa-drive-*` prefixed classes in `styles.css` that the host imports. Every color/space value reads `var(--owa-drive-*, <fallback>)` so hosts theme via custom properties. A `classNames` prop bag allows per-element class overrides. Accepted consequence: both apps' existing Drive card appearance changes.
18. The trailing explanation line is a host-supplied `description?: ReactNode` slot, never a package constant (portfolio = manual sync, notesdiary = auto sync; no shared copy exists).
19. Status freshness: store refreshes on widget mount, on `document visibilitychange -> visible`, and after the widget's own connect/disconnect. `refresh()` is public so hosts can call it after their own op hits `NeedsReauthError`. No drive-sync connection-change subscription this phase.
20. Exported types: `DriveAuthHandle`, `DriveAuthStatus`, `DriveAuthOptions`, `GoogleDriveWidgetProps`. `Connection` is re-exported as a type from drive-sync for host convenience.
21. `DriveAuthStatus` shape ported from portfolio: `{ connected, email, expiresAt, needsReauth, tokenValid }` plus UI-only fields `connecting: boolean` and `error: string | null`.
22. `useDriveConnection(auth)` returns `{ connected, email, connecting, error, needsReauth, refresh }`, backed by the handle store via `useSyncExternalStore` (same pattern as `packages/project-sync/src/react/index.ts`).
23. Tests drive the REAL `createDriveSync` facade with `createGisFake()` + `createDriveFake()` + `fake-indexeddb` installed, not a hand-written stub facade — that is what makes the token-runway and single-popup assertions meaningful.
24. `build` script is `tsc && cp src/styles.css dist/styles.css` — `tsc` does not copy non-TS assets, and `files: ["dist", "README.md", "design.md", "product-behavior.md"]` ships them.
25. **`activate()` is HOST-CALLED. The widget NEVER calls it on mount.** The handle exposes `activate()` (passthrough to `drive.activate()`, returning its disposer); hosts wire it to their own lifecycle. Rationale: portfolio deliberately delays Drive token warm-up until after its password unlock, and it mounts the widget inside its pre-unlock PasswordGate — a widget that self-activated on mount would start warm-up too early and break that.
26. **`popup_closed` recovery lives in drive-sync and is NOT reimplemented here.** Verified: `packages/drive-sync/src/token.ts` already probes for a completed grant with `prompt: 'none'` when GIS reports `popup_closed`, with regression coverage in `packages/drive-sync/src/__tests__/popup-closed-recovery.test.ts`, and the compiled recovery ships in the published 0.5.7 dist. drive-connect's `connect()` therefore passes GIS/consent failures through from `project.connect()` UNCHANGED and adds NO app-level "re-read the connection to see if it actually worked" dance. Note: notesdiary currently carries a redundant app-level copy of this recovery; phase 2 (`drive-connect-p2-notesdiary`) deletes it. Nothing in phase 1 depends on that deletion.
27. **Consumption model is published npm, not a workspace/`file:` link.** Consumers pin a real range (`^0.1.0`). Phases 2 and 3 are BLOCKED until `0.1.0` is actually published and installable from the registry — neither app may adopt drive-connect via `file:../owa/packages/drive-connect` or an npm workspace link.

## Affected files
- `packages/drive-connect/package.json` — NEW: name, version 0.1.0, exports `.` + `./styles.css`, peer deps, build/test scripts.
- `packages/drive-connect/tsconfig.json` — NEW: extends `../../tsconfig.base.json`, `declaration`, `outDir: dist`, `rootDir: src`, excludes `src/__tests__`.
- `packages/drive-connect/vitest.config.ts` — NEW: `environment: 'jsdom'`, `globals: true`, setup file.
- `packages/drive-connect/src/types.ts` — NEW: `DriveAuthOptions`, `DriveAuthStatus`, `DriveAuthHandle`, `GoogleDriveWidgetProps`, `DriveWidgetClassNames`.
- `packages/drive-connect/src/statusStore.ts` — NEW: subscribable snapshot store.
- `packages/drive-connect/src/auth.ts` — NEW: `createDriveAuth()` — status/connect/disconnect/ensureFresh/refresh/subscribe/activate + `isTokenUsable`.
- `packages/drive-connect/src/useDriveConnection.ts` — NEW: `useSyncExternalStore`-backed hook.
- `packages/drive-connect/src/GoogleDriveWidget.tsx` — NEW: the four-state component.
- `packages/drive-connect/src/styles.css` — NEW: `owa-drive-*` classes, `--owa-drive-*` themable tokens.
- `packages/drive-connect/src/index.ts` — NEW: barrel; the single public entry point.
- `packages/drive-connect/src/__tests__/setup.ts` — NEW: jsdom + fake-indexeddb + jest-dom matchers.
- `packages/drive-connect/src/__tests__/harness.ts` — NEW: builds a real drive-sync facade over the fakes.
- `packages/drive-connect/src/__tests__/auth.test.ts` — NEW: handle-level tests.
- `packages/drive-connect/src/__tests__/widget.test.tsx` — NEW: widget/hook tests.
- `packages/drive-connect/README.md` — NEW: install/usage/theming.
- `packages/drive-connect/design.md` — NEW: reference doc (structure, API contract, data flow).
- `packages/drive-connect/product-behavior.md` — NEW: reference doc (user-visible behavior, states, edge cases).
- `.github/workflows/publish.yml` — add `drive-connect-v*` tag trigger + `publish-drive-connect` job.
- `CLAUDE.md` (repo root) — add drive-connect auto-tagging rule.
- Root `package.json` — NO change (`workspaces: ["packages/*"]` already covers it).

## Tasks

### T0 — Create git worktree
**Deps:** none
**Files:** none (git only)
**Do:** From `/home/mohan/owa/owa`, run `git worktree add ../worktree-drive-connect -b feature/drive-connect-package`, then `cd ../worktree-drive-connect`. Every task below happens inside this worktree.
**Test cases:** n/a
**Acceptance:** worktree exists at `../worktree-drive-connect`, branch `feature/drive-connect-package` checked out, cwd is the worktree.

### T1 — Scaffold package skeleton
**Deps:** T0
**Files:** `packages/drive-connect/package.json`, `packages/drive-connect/tsconfig.json`, `packages/drive-connect/vitest.config.ts`
**Do:** Read `packages/project-sync/package.json` + `tsconfig.json` + `vitest.config.ts` first, copy their shape.
- `package.json`: name `@open-webapp/drive-connect`, `version: "0.1.0"`, `type: "module"`, `repository` block with `directory: "packages/drive-connect"`, `exports`: `"."` → `{ types: "./dist/index.d.ts", default: "./dist/index.js" }` and `"./styles.css"` → `"./dist/styles.css"`. `files: ["dist", "README.md", "design.md", "product-behavior.md"]`. Scripts: `build: "tsc && cp src/styles.css dist/styles.css"`, `test: "vitest run"`. `peerDependencies`: `{ "@open-webapp/drive-sync": "^0.6.0", "react": "^19" }` (neither optional). `devDependencies`: `@open-webapp/drive-sync` (workspace `*`), `@testing-library/dom`, `@testing-library/jest-dom`, `@testing-library/react`, `@types/react`, `@types/react-dom`, `react`, `react-dom`, `typescript`, `vitest`, `jsdom`, `fake-indexeddb`. `publishConfig: { access: "public" }`.
- `tsconfig.json`: extends `../../tsconfig.base.json`, `declaration: true`, `outDir: "dist"`, `rootDir: "src"`, `include: ["src"]`, `exclude: ["src/__tests__"]`.
- `vitest.config.ts`: `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/__tests__/setup.ts']`, `esbuild: { target: 'esnext' }`.
- Run `npm install` from repo root so the workspace links.
**Test cases:**
- happy: `npm -w packages/drive-connect run build` runs (may fail on missing src — that's expected until T9).
- edge: root `npm install` resolves the new workspace without touching other packages' lockfile entries beyond the new ones.
- error: n/a.
**Acceptance:** `node -e "require('./packages/drive-connect/package.json')"` doesn't throw; `node_modules/@open-webapp/drive-connect` symlink exists after install.

### T2 — Define public types
**Deps:** T1
**Files:** `packages/drive-connect/src/types.ts`
**Do:** Read `packages/drive-sync/src/types.ts` `Connection` first. Write:
```ts
import type { DriveSync, Connection } from '@open-webapp/drive-sync';
import type { ReactNode } from 'react';

export interface DriveAuthOptions {
  drive: DriveSync;
  projectId: string;
  tokenBufferMs?: number;                       // default 5*60*1000
  beforeInteractive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface DriveAuthStatus {
  connected: boolean;
  email: string | null;
  expiresAt: number | null;
  needsReauth: boolean;
  tokenValid: boolean;
  connecting: boolean;
  error: string | null;
}

export interface DriveAuthHandle {
  getStatus(): DriveAuthStatus;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<DriveAuthStatus>;
  connect(): Promise<Connection>;
  disconnect(): Promise<void>;
  ensureFresh(): Promise<Connection>;
  activate(): () => void;
}

export interface DriveWidgetClassNames {
  root?: string; status?: string; email?: string; connectButton?: string;
  disconnectButton?: string; reauth?: string; error?: string; description?: string;
}

export interface GoogleDriveWidgetProps {
  auth: DriveAuthHandle;
  onConnected?: (connection: Connection) => void;
  onDisconnected?: () => void;
  classNames?: DriveWidgetClassNames;
  description?: ReactNode;
}
```
Re-export `Connection` type from here for host convenience.
**Test cases:**
- happy: `tsc --noEmit` type-checks a `DriveAuthOptions` built with only `drive` + `projectId`.
- edge: `beforeInteractive` accepts a generic wrapper `<T>(fn: () => Promise<T>) => Promise<T>` without losing `T` at call sites.
- error: n/a (compile-time only).
**Acceptance:** `npx tsc --noEmit` clean in `packages/drive-connect`; all four named types exported.

### T3 — Status store
**Deps:** T2
**Files:** `packages/drive-connect/src/statusStore.ts`
**Do:** Read `packages/project-sync/src/react/index.ts`'s store classes for the shape. Write a tiny non-React store:
- `createStatusStore(initial: DriveAuthStatus)` → `{ get(), set(next), patch(partial), subscribe(fn) }`.
- `get()` returns a STABLE object reference — only replace the snapshot when a field actually differs (shallow compare all 7 fields). This is required for `useSyncExternalStore` not to loop.
- `set`/`patch` notify all listeners only when the snapshot reference actually changed.
- Initial disconnected snapshot: `{ connected:false, email:null, expiresAt:null, needsReauth:false, tokenValid:false, connecting:false, error:null }`.
**Test cases:**
- happy: `set()` with a different email notifies listeners once, `get()` returns new object.
- edge: `set()` with an identical snapshot does NOT notify and `get()` returns the SAME reference (identity check).
- error: unsubscribing inside a listener during notify doesn't throw or skip other listeners.
**Acceptance:** `tsc --noEmit` clean; behavior verified by T8's tests.

### T4 — createDriveAuth: status, subscribe, refresh, activate
**Deps:** T3
**Files:** `packages/drive-connect/src/auth.ts`
**Do:** Read `portfolio/src/lib/drive.ts` lines 169-252 first — this is the reference implementation.
- Module-private `isTokenUsable(conn: Connection | null, bufferMs: number): conn is Connection` — port decision 9 verbatim.
- `createDriveAuth({ drive, projectId, tokenBufferMs = 5*60*1000, beforeInteractive })`:
  - Create the status store (T3).
  - `const project = () => drive.project(projectId)` (call per-use, do not cache the handle).
  - `getStatus()` → `store.get()`.
  - `subscribe(fn)` → `store.subscribe(fn)`.
  - `refresh()` → `await project().getConnection()`, map to a status snapshot (`connected: conn !== null`, `email`, `expiresAt`, `needsReauth`, `tokenValid: isTokenUsable(conn, tokenBufferMs)`), preserve current `connecting`, clear nothing else; `store.set(...)`; return snapshot. NEVER interactive, NEVER wrapped by `beforeInteractive`, never throws to the caller for a missing connection (a null connection is a valid disconnected snapshot). A thrown error from `getConnection()` propagates.
  - `activate()` → `drive.activate()` passthrough, returns its teardown fn. HOST-CALLED ONLY (decision 25) — nothing inside this package may call it, and the widget must not call it on mount.
- Leave `connect`/`disconnect`/`ensureFresh` as stubs throwing `not implemented` — T5/T6 fill them.
**Test cases:**
- happy: with a stored connection, `refresh()` returns `connected:true` + the right email and notifies subscribers.
- edge: no stored connection → `refresh()` returns the all-false disconnected snapshot, does not throw.
- error: `getConnection()` rejecting propagates the rejection; status snapshot left untouched.
**Acceptance:** `tsc --noEmit` clean; `refresh()` never triggers an interactive flow (assert `gisFake.calls.length === 0` in T8).

### T5 — connect / disconnect (in-flight guard, timeout, beforeInteractive)
**Deps:** T4
**Files:** `packages/drive-connect/src/auth.ts`
**Do:** Read `portfolio/src/App.tsx` `handleConnect` (~line 352) and `handleDisconnect` (~line 396), and `notesdiary/src/lib/drive.ts` lines 40-100 for `withReloadSuppressed` placement.
- Instance-level `let connectInFlight: Promise<Connection> | null = null` inside the closure (ONE per handle instance — this is the guard both the widget button and `ensureFresh()` share).
- `const wrap = beforeInteractive ?? (<T,>(fn: () => Promise<T>) => fn())`.
- `connect()`:
  - if `connectInFlight` → return it (do NOT start a second flow, do NOT reset `connecting`).
  - else `store.patch({ connecting: true, error: null })`, then set `connectInFlight` to a promise that:
    - races `wrap(() => project().connect())` against a 10s timeout rejecting `new Error('Google auth timed out')`,
    - on success: `await refresh()`, `patch({ connecting:false, error:null })`, resolve with the `Connection`,
    - on failure: `store.set(disconnectedSnapshot with error: message)` (clears `connected`/`email`/`tokenValid`, `connecting:false`), rethrow,
    - `.finally(() => { connectInFlight = null })`.
  - Throw if `connect()` resolves falsy (port portfolio's `if (!connection) throw new Error('No connection returned from Google Drive')`).
  - GIS/consent failures (`popup_closed`, `NeedsReauthError`, denied consent) pass through from `project.connect()` UNCHANGED (decision 26). drive-sync already runs its own `prompt: 'none'` probe for `popup_closed`; do NOT add any app-level re-read-the-connection retry here.
- `disconnect()`: `patch({ connecting: true, error: null })` → `await wrap(() => project().disconnect())` → `store.set(disconnected snapshot)`; on failure `patch({ connecting:false, error: message })` and rethrow. Do NOT route disconnect through `connectInFlight`.
- No `window.alert` anywhere.
**Test cases:**
- happy: `connect()` resolves a `Connection`, status ends `connected:true, connecting:false, error:null`.
- edge: two `connect()` calls fired back-to-back before the first settles resolve to the SAME promise and produce exactly ONE interactive auth call (`gisFake.calls.length === 1`).
- edge: `beforeInteractive` is invoked exactly once per `connect()` and once per `disconnect()`, and NOT at all for `refresh()` or a cached-token `ensureFresh()`.
- error: interactive connect hanging past 10s (fake timers) rejects `Google auth timed out`, status → disconnected with that `error` string, `connectInFlight` reset so a later `connect()` starts a fresh flow.
- error: `disconnect()` rejecting leaves `connecting:false` and sets `error`, and does NOT clear the connected status.
- error: a `NeedsReauthError` that SURVIVES drive-sync's own `popup_closed` probe is neither swallowed nor double-handled — it propagates out of `connect()`, lands in the store as the inline widget error, and resets `connectInFlight` so the next click starts a fresh flow.
**Acceptance:** `tsc --noEmit` clean; grep for `alert(` in `src/` returns nothing; grep for `prompt` / `'none'` / any retry-after-popup-closed logic in `src/` returns nothing (decision 26).

### T6 — ensureFresh + token-runway rule
**Deps:** T5
**Files:** `packages/drive-connect/src/auth.ts`
**Do:** Port `ensureFreshConnection` exactly:
```ts
async ensureFresh() {
  const conn = await project().getConnection();
  if (isTokenUsable(conn, tokenBufferMs)) return conn;   // no popup, no beforeInteractive
  return connect();                                       // shares the SAME connectInFlight guard
}
```
No separate guard, no duplicated timeout logic — it calls the public `connect()`.
**Test cases:**
- happy: connection expiring in 10 min with default 5 min buffer → returns cached conn, zero interactive calls.
- edge (boundary): `expiresAt === Date.now() + tokenBufferMs` exactly → NOT usable (strict `>`), triggers interactive connect. `expiresAt = now + tokenBufferMs + 1` → usable.
- edge: `needsReauth: true` with a far-future `expiresAt` → NOT usable, triggers connect.
- edge: `expiresAt: null` → NOT usable, triggers connect.
- edge: `ensureFresh()` and the widget's Connect button firing concurrently → exactly ONE auth popup (shared guard).
- error: connect failing inside `ensureFresh()` rejects with the connect error, status disconnected.
**Acceptance:** `tsc --noEmit` clean; all six cases covered in T8.

### T7 — Test harness + setup
**Deps:** T1
**Files:** `packages/drive-connect/src/__tests__/setup.ts`, `packages/drive-connect/src/__tests__/harness.ts`
**Do:** Read `packages/drive-sync/src/__tests__/` setup and `packages/drive-sync/src/testing/{gisFake,driveFake}.ts` first.
- `setup.ts`: import `fake-indexeddb/auto`, `@testing-library/jest-dom/vitest`, and add an `afterEach` that clears fake-indexeddb databases between tests so connections don't leak across cases.
- `harness.ts`: export `makeHarness()` returning `{ drive, gisFake, driveFake, projectId, seedConnection(opts), cleanup() }`:
  - installs `createGisFake()` and `createDriveFake()`,
  - builds a REAL facade: `createDriveSync({ appId: 'test-app', clientId: 'test-client', folderPath: ['Test'], })` with the drive fake's `fetch` installed as the global fetch,
  - `seedConnection({ email, expiresAt, needsReauth })` establishes a stored connection by running one fake-backed `connect()` then, where a specific expiry/needsReauth state is needed, driving the fake's queued token response to produce it (prefer producing states through the real code path; only fall back to direct storage writes if the fake cannot express a state — document that in a comment),
  - `cleanup()` uninstalls both fakes and restores global fetch.
**Test cases:**
- happy: `makeHarness()` then `drive.project(id).getConnection()` returns null before any connect.
- edge: two harnesses in the same file don't share IndexedDB state (per-test cleanup works).
- error: `cleanup()` called twice doesn't throw.
**Acceptance:** a throwaway smoke test using the harness passes under `vitest run`.

### T8 — auth.test.ts
**Deps:** T6, T7
**Files:** `packages/drive-connect/src/__tests__/auth.test.ts`
**Do:** Write the handle-level suite covering, one `it()` each:
1. `refresh()` disconnected → all-false snapshot, zero `gisFake.calls`.
2. `refresh()` connected → email/expiresAt/needsReauth/tokenValid mapped correctly, subscriber notified once.
3. Token-runway boundary table: `now+buffer` (not usable), `now+buffer+1` (usable), `expiresAt:null` (not usable), `needsReauth:true` (not usable) — assert popup vs no-popup per row.
4. Single-popup guard: `Promise.all([auth.connect(), auth.connect()])` → `gisFake.calls.length === 1`, both resolve same value.
5. Single-popup guard across entry points: `Promise.all([auth.ensureFresh(), auth.connect()])` with no usable token → `gisFake.calls.length === 1`.
6. Connect failure: queue a popup error on `gisFake` → `connect()` rejects, status disconnected with `error` set, and a subsequent `connect()` starts a NEW flow (guard was reset).
7. Connect timeout: `vi.useFakeTimers()`, make the fake never settle, advance 10s → rejects `Google auth timed out`, status disconnected.
8. `beforeInteractive` wrapping: a spy wrapper is called for `connect()` and `disconnect()` and NOT for `refresh()` or a cached-token `ensureFresh()`.
9. `disconnect()` success clears status; `disconnect()` failure sets `error`, keeps status connected.
10. `activate()` returns a teardown function and calling it doesn't throw; nothing else in the package calls it (spy on `drive.activate`, run every other handle method, assert zero calls) — decision 25.
11. No-alert: `vi.spyOn(window, 'alert')`, run connect success + connect failure + disconnect failure → spy never called.
12. `popup_closed` passthrough (decision 26): queue a `gisFake` popup error that drive-sync's own `prompt:'none'` probe cannot recover; assert `connect()` rejects with drive-sync's error unchanged (same instance/name, not rewrapped), status holds it as `error`, and `connectInFlight` is reset so the next `connect()` opens a new flow. No extra `getConnection()` retry is issued by drive-connect (assert the `getConnection` call count for the failure path).
**Test cases:** enumerated above (happy = 1/2/4; edge = 3/5/8/10; error = 6/7/9/11/12).
**Acceptance:** `npx vitest run src/__tests__/auth.test.ts` green; `gisFake` call-count assertions are exact numbers, not `toBeGreaterThan`.

### T9 — useDriveConnection hook
**Deps:** T6
**Files:** `packages/drive-connect/src/useDriveConnection.ts`
**Do:** Read `packages/project-sync/src/react/index.ts` for the `useSyncExternalStore` pattern.
```ts
export function useDriveConnection(auth: DriveAuthHandle) {
  const status = useSyncExternalStore(auth.subscribe, auth.getStatus, auth.getStatus);
  ...
}
```
- `subscribe` and `getStatus` must be stable references (bind them in `createDriveAuth`'s closure, or wrap in `useCallback` keyed on `auth`).
- Returns `{ connected, email, connecting, error, needsReauth, refresh }` where `refresh` is `auth.refresh` (stable).
- The hook itself does NOT auto-refresh on mount — that lives in the widget (decision 19), so a host using the hook alone isn't surprised by side effects.
- `getServerSnapshot` = same `getStatus` (store snapshot is already synchronous and stable).
**Test cases:**
- happy: rendering a component with the hook shows the current status; calling `auth.connect()` re-renders with `connected:true`.
- edge: repeated renders do not loop (snapshot identity is stable) — assert render count with a counter ref.
- error: `error` from a failed connect surfaces in the hook's returned object.
**Acceptance:** `tsc --noEmit` clean; no "getSnapshot should be cached" React warning in test output.

### T10 — GoogleDriveWidget component
**Deps:** T9
**Files:** `packages/drive-connect/src/GoogleDriveWidget.tsx`
**Do:** Read `portfolio/src/components/DriveRestorePanel.tsx` lines 132-165 and `notesdiary/src/components/SettingsView.tsx` `section === 'drive'` block for the markup being ported.
- `function GoogleDriveWidget({ auth, onConnected, onDisconnected, classNames, description })`.
- `const { connected, email, connecting, error, needsReauth } = useDriveConnection(auth)`.
- `useEffect` on mount: `auth.refresh()` ONLY (swallow rejection into store error, don't throw in render). The widget must NEVER call `auth.activate()` — warm-up is host-driven (decision 25).
- `useEffect`: `document.addEventListener('visibilitychange', ...)` → when `document.visibilityState === 'visible'` call `auth.refresh()`. Remove listener on unmount.
- Handlers:
  - `handleConnect` → `try { const conn = await auth.connect(); onConnected?.(conn) } catch { /* store already holds the error */ }`
  - `handleDisconnect` → `try { await auth.disconnect(); onDisconnected?.() } catch { /* store holds error */ }`
  - Never call `alert`. Never rethrow into render.
- Markup (class = `cn(classNames?.x, 'owa-drive-x')` merge; package class always present, host class appended):
  - root `<div className="owa-drive-root">`
  - not connected: `<button className="owa-drive-connect" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect Google Drive'}</button>`
  - connected: `<p className="owa-drive-status">Connected as <span className="owa-drive-email">{email}</span></p>` + `<button className="owa-drive-disconnect" disabled={connecting}>Disconnect</button>`
  - connected && needsReauth: `<div className="owa-drive-reauth">` with text `Reconnect to restore sync` + `<button className="owa-drive-connect">Reconnect</button>`
  - `error` → `<p className="owa-drive-error" role="alert">{error}</p>`
  - `description` → `<div className="owa-drive-description">{description}</div>` only when provided.
- Disconnect must be a `<button type="button">`, never a span (decision 16).
**Test cases:**
- happy: connected + no reauth renders email and a Disconnect button.
- edge: `needsReauth` renders BOTH the warning text and a Reconnect button, and does NOT render a second Connect button.
- edge: `description` omitted → no description node in the DOM.
- error: `error` set → exactly one `role="alert"` node containing the message.
**Acceptance:** `tsc --noEmit` clean; component has no `window.alert`, no inline `style` attribute for anything a CSS class can do.

### T11 — styles.css
**Deps:** T10
**Files:** `packages/drive-connect/src/styles.css`
**Do:** Write the package stylesheet. Rules:
- Every class prefixed `owa-drive-`, matching exactly the class names T10 emits.
- Every color/spacing/font value is `var(--owa-drive-<token>, <fallback>)`. Minimum token set: `--owa-drive-fg`, `--owa-drive-muted`, `--owa-drive-accent`, `--owa-drive-accent-fg`, `--owa-drive-danger`, `--owa-drive-gap`, `--owa-drive-radius`, `--owa-drive-font`.
- `.owa-drive-disconnect { background:none; border:0; padding:0; cursor:pointer; text-decoration:underline; color: var(--owa-drive-muted, #666); font: inherit; }`
- `.owa-drive-error { color: var(--owa-drive-danger, #b00020); }`
- `:disabled { cursor: default; opacity: .6 }` on the buttons.
- No `:root {}` block forcing token values — hosts define them; the fallbacks are the defaults.
**Test cases:**
- happy: file parses (no CSS build step; verify by eye + that every class in the component appears in the file).
- edge: grep the component's class list against the stylesheet — no orphan class either direction.
- error: n/a.
**Acceptance:** every `owa-drive-*` class in `GoogleDriveWidget.tsx` has a rule in `styles.css` and vice versa; every literal color/space appears inside a `var(..., fallback)`.

### T12 — widget.test.tsx: four states + hook
**Deps:** T7, T10
**Files:** `packages/drive-connect/src/__tests__/widget.test.tsx`
**Do:** With `@testing-library/react` + the T7 harness, assert the four states from decision 15:
1. Not connected → "Connect Google Drive" button present, enabled; no email, no Disconnect.
2. Connecting → after clicking Connect with the fake held pending, button shows "Connecting…" and `toBeDisabled()`.
3. Connected → "Connected as {email}" text + a Disconnect **button** (`getByRole('button', { name: 'Disconnect' })` — this fails if it's a span, which is the point).
4. Connected + needsReauth → "Reconnect to restore sync" text + "Reconnect" button.
Plus: mount triggers exactly one `auth.refresh()` and ZERO `auth.activate()` calls (spy on both — decision 25); dispatching `visibilitychange` with `visibilityState: 'visible'` triggers another refresh; unmount removes the listener (dispatch after unmount → no further refresh).
**Test cases:** the four states above (happy = 1/3, edge = 2/4), plus the refresh-lifecycle trio (edge), plus unmount-after-listener-removal (error path for leaks).
**Acceptance:** `npx vitest run src/__tests__/widget.test.tsx` green; state 3 asserts via `getByRole('button')`, not `getByText`.

### T13 — widget.test.tsx: flows, callbacks, errors
**Deps:** T12
**Files:** `packages/drive-connect/src/__tests__/widget.test.tsx`
**Do:** Add to the same file:
1. Connect success → `onConnected` called exactly once with the `Connection` (assert `.email`); widget flips to connected state.
2. Connect failure (queued popup error) → `onConnected` NOT called; a `role="alert"` node holds the message; widget back in not-connected state; button re-enabled.
3. Connect timeout (fake timers, 10s) → `role="alert"` shows `Google auth timed out`.
4. Disconnect success → `onDisconnected` called once; widget back to not-connected.
5. Disconnect failure → `onDisconnected` NOT called; `role="alert"` shows the message.
6. Clicking Connect twice rapidly → exactly one `gisFake` auth call (the guard, observed through the UI).
7. `classNames` prop bag: pass `{ root: 'x-root', connectButton: 'x-connect' }`, assert BOTH the host class and the `owa-drive-*` class are present on those nodes.
8. `description` prop renders the supplied node.
9. No-alert: `vi.spyOn(window, 'alert')` across the whole file's `beforeEach`, assert never called at the end of each flow test.
**Test cases:** happy = 1/4/7/8; edge = 6; error = 2/3/5/9.
**Acceptance:** file green; the alert spy assertion is present in every flow test, not just one.

### T14 — index.ts barrel
**Deps:** T6, T9, T10
**Files:** `packages/drive-connect/src/index.ts`
**Do:**
```ts
export { createDriveAuth } from './auth.js';
export { useDriveConnection } from './useDriveConnection.js';
export { GoogleDriveWidget } from './GoogleDriveWidget.js';
export type {
  DriveAuthHandle, DriveAuthStatus, DriveAuthOptions,
  GoogleDriveWidgetProps, DriveWidgetClassNames, Connection,
} from './types.js';
```
Nothing else exported — no store internals, no `isTokenUsable`.
**Test cases:**
- happy: an import-shape test asserts `typeof createDriveAuth === 'function'`, same for the hook and component.
- edge: importing the barrel in a Node (non-jsdom) context doesn't crash at module scope (no top-level `document` access anywhere).
- error: internal modules (`statusStore.js`) are NOT reachable from the barrel.
**Acceptance:** add the import-shape assertions to `auth.test.ts`; `npx tsc --noEmit` clean.

### T15 — README.md
**Deps:** T14
**Files:** `packages/drive-connect/README.md`
**Do:** Read `packages/drive-sync/README.md` for tone/length. Cover: what the package owns (auth only) and explicitly what it does NOT own; install line; a usage snippet where the host calls `createDriveSync(...)` itself and passes the facade to `createDriveAuth`; `import '@open-webapp/drive-connect/styles.css'`; the `--owa-drive-*` theming token table; the `classNames` bag; a note that `ensureFresh()` is the call plain module code should use before Drive I/O; one-line pointer to `design.md` / `product-behavior.md`.
Also document, each as its own short subsection:
- **Warm-up is yours to wire** (decision 25): `activate()` is host-called and returns a disposer; the widget never calls it. Show the host pattern (`useEffect(() => auth.activate(), [auth])`) and say why an app may want to delay it (e.g. until after a password unlock, when the widget itself mounts pre-unlock).
- **Install from npm** (decision 27): `npm i @open-webapp/drive-connect@^0.1.0` plus the two peers. No `file:`/workspace-link consumption.
- **Popup-closed recovery is drive-sync's job** (decision 26): drive-connect surfaces auth errors as-is; do not add app-level retries on top.
**Test cases:** n/a (docs).
**Acceptance:** every exported symbol from T14 appears in the README; the usage snippet type-checks if pasted (verify by eye against the real signatures); the three subsections above are present.

### T16 — design.md reference doc
**Deps:** T14
**Files:** `packages/drive-connect/design.md`
**Do:** Per the reference-doc rules in `portfolio/CLAUDE.md`: terse, agent-optimized, current-state only, no history/rationale/roadmap. Sections: directory structure; API contract (exact signatures); component tree; state management (store + `useSyncExternalStore`, snapshot identity rule); data model (`DriveAuthStatus` field table); data flows (`connect`, `disconnect`, `ensureFresh` cached vs interactive, `refresh` triggers); design patterns (host-owned facade, single in-flight guard, `beforeInteractive` wrapper boundary, CSS custom-property theming). One-line pointer to `product-behavior.md` at top.
**Test cases:** n/a (docs).
**Acceptance:** no narrative prose; signatures match `src/` exactly; no mention of phases 2/3 or of anything not yet built.

### T17 — product-behavior.md reference doc
**Deps:** T14
**Files:** `packages/drive-connect/product-behavior.md`
**Do:** Terse, current-state only. Sections: the four widget states with exact rendered strings; what each button does; error display (inline `role="alert"`, never `window.alert`); keyboard interaction (Disconnect is a real button — Tab-reachable, Enter/Space activates); status-freshness triggers (mount, `visibilitychange -> visible`, post-connect/disconnect, host-called `refresh()`); **what the widget does NOT do on mount** — it refreshes status only, it never starts token warm-up; `activate()` is host-called and host-disposed (decision 25); edge cases (double-click Connect = one popup; 10s timeout message; `needsReauth` while still "connected"; token-runway buffer meaning; a closed OAuth popup that drive-sync recovers from silently succeeds, and one it cannot recover from shows the auth error inline with the Connect button re-enabled — decision 26). One-line pointer to `design.md` at top.
**Test cases:** n/a (docs).
**Acceptance:** every string in the doc matches a string actually rendered by `GoogleDriveWidget.tsx`.

### T18 — Full build + typecheck + test gate
**Deps:** T8, T11, T13, T15, T16, T17
**Files:** none (verification only)
**Do:** From the worktree root: `npm install`, `npm -w packages/drive-connect run build`, `npx tsc --noEmit -p packages/drive-connect`, `npm -w packages/drive-connect run test`. Then `npm run build -ws` and `npm run test -ws` to confirm the new workspace breaks nothing else. Fix all fallout here — do not defer.
**Test cases:**
- happy: build emits `dist/index.js`, `dist/index.d.ts`, AND `dist/styles.css` (the `cp` step actually ran).
- edge: run the test suite twice back-to-back — no order-dependent failures from fake-indexeddb or fake install/uninstall leakage.
- error: any failing existing drive-sync/project-sync test caused by the root `npm install` is fixed before proceeding.
**Acceptance:** all four commands exit 0; `ls packages/drive-connect/dist/styles.css` succeeds.

### T19 — Publish wiring
**Deps:** T18
**Files:** `.github/workflows/publish.yml`, `CLAUDE.md`
**Do:**
- `publish.yml`: add `'drive-connect-v*'` to the `on.push.tags` list; add a `publish-drive-connect` job copied from `publish-project-sync` (guard `if: startsWith(github.ref, 'refs/tags/drive-connect-v')`), building `packages/drive-sync` first (peer dep must exist in the workspace for `tsc`) then `packages/drive-connect`, then `npm publish --access public --provenance --workspace packages/drive-connect`.
- `CLAUDE.md`: add a **For drive-connect:** section mirroring the existing two — extract version from `packages/drive-connect/package.json`, `git tag drive-connect-v<version>`, `git push origin drive-connect-v<version>`.
**Test cases:**
- happy: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish.yml'))"` parses.
- edge: the three job `if:` guards are mutually exclusive (a `drive-sync-v*` tag must not also match `drive-connect-v*` — confirm prefix strings differ).
- error: n/a.
**Acceptance:** workflow YAML valid; three jobs present; `CLAUDE.md` documents all three packages.

### T20 — Commit
**Deps:** T19
**Files:** none (git only)
**Do:** From the worktree: `git add packages/drive-connect .github/workflows/publish.yml CLAUDE.md package-lock.json`, commit describing the new package (createDriveAuth handle, single in-flight guard, useDriveConnection, GoogleDriveWidget, shipped CSS, test suite over drive-sync fakes, publish wiring). Do NOT commit `dist/`.
**Test cases:** n/a
**Acceptance:** commit on `feature/drive-connect-package`, `git status` clean, `git show --stat` lists no `dist/` paths.

### T21 — Merge to main
**Deps:** T20
**Files:** none (git only)
**Do:** `cd /home/mohan/owa/owa` (the main worktree), `git merge feature/drive-connect-package`. Resolve nothing expected (all files new except two).
**Test cases:** n/a
**Acceptance:** `main` contains the commit; `packages/drive-connect/package.json` exists on `main`.

### T22 — Tag and push the release tag
**Deps:** T21
**Files:** none (git only)
**Do:** From `/home/mohan/owa/owa`: read version from `packages/drive-connect/package.json` (`0.1.0`), then `git tag drive-connect-v0.1.0 && git push origin drive-connect-v0.1.0`. This is the owa repo's documented release mechanism (root `CLAUDE.md`) — pushing the TAG only, not the branch. Phase 1 is NOT done when the tag is pushed; it is done when the registry serves an installable `0.1.0` (decision 27) — phases 2 and 3 are blocked until then, and neither may unblock itself with a `file:`/workspace link.
**Test cases:**
- happy: `git tag -l 'drive-connect-v*'` lists `drive-connect-v0.1.0`; the GitHub Actions `publish-drive-connect` job starts and succeeds.
- happy: `npm view @open-webapp/drive-connect version` returns `0.1.0`, and a clean `npm i @open-webapp/drive-connect@^0.1.0` in a scratch dir installs it with `dist/index.js`, `dist/index.d.ts`, and `dist/styles.css` present in the tarball (`npm pack` / `npm view ... files` check).
- edge: tag points at the merge commit on `main`, not at a worktree-only commit (`git log drive-connect-v0.1.0 -1` matches `main`'s HEAD).
- error: if the publish job fails, fix and re-release under `0.1.1` — never move an existing tag.
**Acceptance:** tag pushed; workflow run green; `0.1.0` resolvable and installable from the public registry with the stylesheet in the published tarball. Only at this point are `drive-connect-p2-notesdiary` and `drive-connect-p3-portfolio` unblocked.

### T23 — Cleanup git worktree
**Deps:** T22
**Files:** none (git only)
**Do:** From `/home/mohan/owa/owa`: `git worktree remove ../worktree-drive-connect`.
**Test cases:** n/a
**Acceptance:** worktree gone (`git worktree list` shows only the main one); cwd is `/home/mohan/owa/owa`; branch `feature/drive-connect-package` still exists with the commit.

## Test strategy
All verification is vitest + jsdom inside `packages/drive-connect`, no live Google credentials. The suite drives the REAL `@open-webapp/drive-sync` facade with `createGisFake()` + `createDriveFake()` + `fake-indexeddb` (T7 harness), so token storage, expiry, and `getConnection()` semantics are the genuine ones — that is what makes the token-runway boundary test (`now+buffer` not usable, `now+buffer+1` usable) and the single-popup guard test (`gisFake.calls.length === 1` for two concurrent callers) real assertions rather than stub theater. `auth.test.ts` covers the handle contract headlessly; `widget.test.tsx` covers the four widget states, the connect/disconnect flows including the 10s fake-timer timeout, the callbacks, the `classNames` merge, and the `description` slot through @testing-library/react. A `window.alert` spy asserts zero calls in every flow test (decision 13). Final gate T18 runs build + typecheck + package tests + the whole-workspace `-ws` build and test, twice, to catch fake install/uninstall and IndexedDB leakage across files.

## Risks
- **API derived from portfolio, but portfolio migrates LAST (phase 3).** Notesdiary (phase 2) will exercise `beforeInteractive` and auto-sync copy; portfolio (phase 3) will exercise manual-sync copy and the backup-file-lookup callback. Expect a minor bump (`0.2.0`) during phase 3 when a gap surfaces. Mitigation: accepted and stated up front; nothing in phase 1 blocks on either app.
- **Both apps' Drive card appearance changes** once they adopt the shipped CSS. Mitigation: accepted decision 17; the `--owa-drive-*` token set + `classNames` bag give each app a cheap path back to its own look in its own phase.
- **No connection-change subscription in drive-sync** means status can go stale if a Drive op elsewhere invalidates the token. Mitigation: `refresh()` is public and the widget refreshes on mount and on tab-visible; hosts are told (README, product-behavior.md) to call `refresh()` after their own op hits `NeedsReauthError`. Deferred deliberately.
- **`tsc` does not copy `styles.css`**, so a naive `build` ships a package whose `./styles.css` export 404s. Mitigation: build script includes `cp` (decision 24) and T18's acceptance explicitly `ls`-checks `dist/styles.css`.
- **`fake-indexeddb` state leaking between tests** would make the guard/runway assertions flaky. Mitigation: T7's setup clears databases in `afterEach`; T18 runs the suite twice.
- **React 19 as a hard peer** narrows adoption vs project-sync's optional/`^18 || ^19` peer. Mitigation: both target apps are on React 19; widening later is non-breaking.
- **Phases 2 and 3 are gated on a real registry publish** (decision 27), so a failed or delayed publish job stalls both downstream plans. Mitigation: T22's acceptance requires an actual `npm view` + clean-install check, not just a green workflow; fix forward as `0.1.1` rather than letting an app work around it with a `file:` link.
- **Tag push triggers a real npm publish.** A broken `0.1.0` cannot be un-published cleanly. Mitigation: T18's full gate runs before T20/T21/T22; a bad release is fixed forward as `0.1.1`, never by moving a tag.

## Open questions
- None blocking. Two items intentionally deferred rather than unresolved: (a) whether `useDriveConnection` should also expose `expiresAt`/`tokenValid` — held back until a host asks; (b) whether the package should later subscribe to a drive-sync connection-change event — out of scope this phase (decision 19).

## Post-change doc updates
- `packages/drive-connect/README.md` — created in T15; install, host-owns-the-facade usage snippet, stylesheet import, `--owa-drive-*` token table, `classNames` bag.
- `packages/drive-connect/design.md` — created in T16; API contract, component tree, state management, data flows. Per `portfolio/CLAUDE.md` reference-doc rules, re-read in full after T18 to check for drift against the finished code.
- `packages/drive-connect/product-behavior.md` — created in T17; four widget states with exact strings, keyboard behavior, error display, refresh triggers, edge cases. Same full re-read after T18.
- Root `CLAUDE.md` — T19; drive-connect auto-tagging rule alongside drive-sync and project-sync.
- `.github/workflows/publish.yml` — T19; new tag trigger + publish job.
- No `packages/drive-sync/SPEC.md` or `packages/project-sync/README.md` change — neither package is touched.
