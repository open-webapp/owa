# `@open-webapp/drive-sync` — Spec

**Status: descriptive, not normative.** Written last, from the shipped code in `src/`. If anything here disagrees with the source, the source is right and this file should be corrected.

## 1. Overview

`drive-sync` is a plain-TypeScript (no React, one runtime dependency — `idb`), browser-only library that owns two things for an app that backs project data onto a user's Google Drive:

- **OAuth token lifecycle**: acquiring, caching, silently refreshing, and revoking a Google Identity Services (GIS) access token, per project.
- **Low-level Drive I/O**: file read/write/list/remove, folder-path resolution, and Drive permissions — all as thin, content-agnostic wrappers around the Drive v3 REST API.

It deliberately does **not** implement any merge/diff logic, file-naming convention, or "sync" abstraction. There is no `sync()` call anywhere in the package. An app decides what a "project" contains, what its files are named, how conflicting versions get merged, and when to call `read`/`write` — the library only gets it there and back, authenticated, retried, and typed.

### Public API

`src/index.ts` exports one factory:

```ts
import { createDriveSync } from '@open-webapp/drive-sync';

const drive = createDriveSync({
  appId: 'planning',
  clientId: GOOGLE_CLIENT_ID,
  folderPath: ['OpenWebApp', 'Planning'],
});

const dispose = drive.activate();               // attach visibility/pageshow listeners
await drive.reconcile(knownProjectIds);          // drop orphaned per-project auth DBs

const p = drive.project(projectId);
await p.connect();                               // interactive; prompt:'consent'
const conn = await p.getConnection();            // { email, needsReauth, expiresAt } | null

const folderId = await p.ensureFolderPath();
const token = await p.getAccessToken();          // raw token, for Google Picker's setOAuthToken() only
const files = await p.files.list({ folderId });
const text = await p.files.read(fileId);         // string | Blob | null (null on 404)
const ref = await p.files.write({ folderId, name: 'x.json', content, mimeType: 'application/json' });
await p.permissions.grant({ fileId, type: 'user', role: 'writer', emailAddress: 'a@b.com' });

await p.disconnect();
await drive.dropProject(projectId);
dispose();
```

`createDriveSync()` itself attaches no listeners and makes no network calls. Every Drive-op call site accepts an optional `{ interactive?: boolean }` (default `false`) and resolves its own token internally — no caller ever threads a token or a `projectId` string into an HTTP call by hand.

Files implementing the surface: `index.ts` (factory + `ProjectHandle`/`FilesHandle`/`PermissionsHandle`), `connection.ts` (`connect`/`getConnection`/`disconnect`/`refreshSilently`/`getAccessToken`), `files.ts`, `permissions.ts`, `reconcile.ts`, `refresh.ts` (`activate`/warm-up), `errors.ts` (typed error classes), `types.ts` (`DriveSyncOptions`, `Connection`, `StoredToken`, `FileRef`, `DrivePermission`, `CallOptions`).

`getAccessToken()` is the one deliberate exception to `Connection` never exposing secret material (types.ts): it exists solely so an app can feed the token to Google Picker (`setOAuthToken()`), which runs outside this library's control and has no other way to read it. Reuses a cached token while it has more than 5 minutes left; otherwise acquires one (interactive by default, since callers use this to drive a UI the user is actively interacting with).

## 2. The 34 resolved design decisions

**Bugs fixed (both source apps carried these):**

1. **Per-request token client, not a module singleton** — `token.ts`'s `acquireToken`/`acquireTokenUncoalesced` creates a fresh `initTokenClient` on every call; nothing closes over the first call's `projectId`.
2. **Scope honored on every call** — the fresh client is configured with `opts.scopes.join(' ')` per call, not baked in once at init.
3. **In-flight coalescing keyed by `(projectId, sorted scopes)`** — `token.ts`'s `coalesceKey` + `inFlight` map; concurrent calls for different projects/scopes never collide.
4. **No clobbered resolvers** — `resolve`/`reject` are captured in each call's own `Promise` closure (`acquireTokenUncoalesced`), never stored on a module-level variable.
5. **Real expiry** — `persistTokenResponse` reads `response.expires_in` and computes `Date.now() + expiresIn * 1000`; no hardcoded `3600`.
6. **`grantedScopes` recorded** — `persistTokenResponse` splits `response.scope` and stores it on the token; `connection.ts`'s `connect()` also copies it onto the durable `ConnRecord`.
7. **401 handled** — `http.ts`'s `performFetch` clears the token, retries once non-interactively, then throws `NeedsReauthError` (see §4).
8. **`hint` on silent refresh** — every non-interactive `acquireToken` call is given `hint: <known email>`; wrong-account tokens are caught by `refreshSilently` (see below and §4).
9. **`response.ok` checked before parsing** — `performFetch` never calls `.json()`/`.text()` on a response without checking `res.ok` first; every status branch is explicit.
10. **429/5xx retry** — `performFetch`'s attempt loop, up to `MAX_ATTEMPTS = 3`, honoring `Retry-After`.
11. **No hand-rolled multipart boundary** — `files.ts`'s `write()` (create path) builds a real `FormData`, serializes it via a throwaway `Request` to get fetch's own computed boundary/Content-Type, and forwards that verbatim.

**Fixes adopted from whichever app had them right:**

12. **GIS load guard** — `gis.ts`'s `waitForGoogleIdentityServices`: 100ms poll, 10s timeout, typed `GisLoadError`.
13. **`ACCESS_TOKEN_SCOPE_INSUFFICIENT` handling** — `http.ts` checks the 403 body for that string and throws `ScopeInsufficientError`, clearing the token first.
14. **`q=` escaping** — `query.ts`'s `escapeQ`: backslash escaped before quote (both apps had this wrong or partial; this is neither app's code, written fresh to the correct rule).
15. **Structured errors, not string parsing** — `errors.ts`'s `DriveSyncError` subclasses carry `status`/`reason`/`retryAfter`/`fileId`/`expectedEmail`/`actualEmail` fields.
16. **`disconnect()` early-returns the revoke POST** when no token is cached — `connection.ts`'s `disconnect()` checks `getToken()` before calling the injected `revokeFn`.

**Other resolved decisions:**

17. **`prompt` selection** — `token.ts`: `interactive ? 'consent' : 'none'`, with `hint` only ever attached on the non-interactive path.
18. **Fully async surface** — no synchronous accessors anywhere in `index.ts`/`connection.ts`/`storage.ts`.
19. **One connection object, not two** — `getConnection()` (`connection.ts`) returns `{ email, needsReauth, expiresAt } | null` rather than a separate `{authenticated, cachedToken}` shape.
20. **Injectable no-op logger** — `logger.ts`'s `Logger` interface + `noOpLogger`, taken as `options.logger` in `createDriveSync`.
21. **`FormData` multipart create** — see #11 above; implemented in `files.ts`.
22. **Content-agnostic payload** — `WriteOptions.content: string | Blob` plus an explicit `mimeType` (`files.ts`).
23. **`folderPath` supplied at factory time** — `DriveSyncOptions.folderPath: string[]`; `ensureFolderPath()` walks it (`files.ts`).
24. **Retry policy** — bounded exponential backoff (`BASE_DELAY_MS * 2^(attempt-1)`), 3 attempts, `Retry-After` honored when present, and **no retry on any non-429 4xx** (`http.ts`).
25–27. **App-side concerns kept out of the library** — `ensureJsonExtension`, CSV filename/content building, and any app-level `connectDriveSync`-style helper are not present anywhere in `src/`; the library only exposes `ensureFolderPath()` + `files.write()` for an app to build such helpers on top of.
28. **No `folderId`/`fileId` persistence** — `ensureFolderPath()` and `write()` both return ids to the caller; nothing in `storage.ts`'s schema has a field for either.
29. **One IndexedDB DB per project** — `storage.ts`'s `dbName(appId, projectId)` → `owa-drive-{appId}-{projectId}`, opened at version `1` with a single object store named `auth`.
30. **`conn`/`token` split** — `storage.ts` stores a durable `ConnRecord` under key `'conn'` and an ephemeral `StoredToken` under key `'token'` in the same `auth` store; `clearToken` deletes only the `'token'` key.
31. **Cross-tab BroadcastChannel — fully wired.** `broadcast.ts` implements `createBroadcast(appId)` with `postLogout`, `postToken`, and `onMessage`, channel-named `owa-drive-{appId}`, feature-detected to a no-op where `BroadcastChannel` is absent. `connection.ts`'s `disconnect()` calls `postLogout`; `token.ts`'s `acquireToken` calls `postToken` after every successful acquisition (interactive `connect()`, silent `refreshSilently()`, and the plain warm-up fallback alike — one choke point right after the token lands in IndexedDB). `index.ts`'s `activate()` subscribes via `onMessage`: a `logout` message evicts this tab's cached IDB handle for that project (`evictDbHandle`) so a subsequent read sees the other tab's cleared storage; a `token` message calls `token.ts`'s `notifyExternalTokenRefresh(projectId)`, which lets this tab's next non-interactive `acquireToken` for that project skip its own GIS round-trip and re-read the fresh token from shared storage instead. Both directions are only live between `activate()` and its disposer — a project handle used without ever calling `.activate()` still reads/writes the same IndexedDB, just without the cross-tab shortcut.
32. **`reconcile`/`dropProject`** — `reconcile.ts`: `reconcile(appId, knownProjectIds)` enumerates via `indexedDB.databases()` and deletes any `owa-drive-{appId}-*` DB not in the known set; `dropProject(appId, projectId)` deletes one DB eagerly and evicts its cached handle.
33. **No timer; warm-up on `visibilitychange`/`pageshow`** — `refresh.ts`'s `activate()` attaches both listeners (only when called; none at import time), gated on `document.visibilityState === 'visible'` / `event.persisted && !document.hidden`; `warmUpIfNeeded` only fires if a connection exists **and** the token is missing or within a 5-minute buffer (`REFRESH_BUFFER_MS`) of expiry. `index.ts`'s top-level `activate()` also layers a `trackedProjectIds` Set so one global listener pair drives warm-ups for every project ever passed to `.project(id)`.
34. **`interactive` option, default `false`** — every `BaseCallOptions`-shaped call in `files.ts`/`permissions.ts`/`http.ts` defaults `interactive` to falsy; a non-interactive call with no usable token throws `NeedsReauthError` rather than silently prompting.

## 3. Storage layout

Each project gets its own IndexedDB database: **`owa-drive-{appId}-{projectId}`**, version 1, containing one object store, `auth` (`storage.ts`). The store holds exactly two keys:

| Key | Shape | Lifetime |
|---|---|---|
| `conn` | `{ email, grantedScopes: string[], connectedAt: number }` | Durable — survives token expiry. Written by `connect()`. Cleared only by `disconnect()`. |
| `token` | `{ accessToken, expiresAt, grantedScopes: string[] }` | Ephemeral. Written by `persistTokenResponse()` on every successful token acquisition. Cleared on 401 (`http.ts`), on `ScopeInsufficientError` (`http.ts`), on a detected wrong-account mismatch (`connection.ts`'s `refreshSilently`), and by `disconnect()`. |

Open handles are cached in-process in a `Map<string, Promise<IDBPDatabase>>` keyed by `${appId}:${projectId}` (`storage.ts`'s `dbCache`), so repeated calls for the same project reuse one connection. `evictDbHandle` closes and drops that cache entry without deleting the underlying database — the deletion itself only happens in `reconcile.ts`.

Two things trigger deleting the whole per-project database:

- **`drive.dropProject(projectId)`** — the eager, app-driven path (e.g. called when a project is deleted in the host app).
- **`drive.reconcile(knownProjectIds)`** — the safety net, run at boot: enumerates every `owa-drive-{appId}-*` database via `indexedDB.databases()` and deletes any whose trailing projectId is not in the supplied set. No-ops (does not throw) where `indexedDB.databases()` is unsupported.

Nothing in this schema stores a Drive `folderId` or `fileId` — those stay app-side by design (#28 above).

## 4. Refresh state machine

Token acquisition always funnels through `token.ts`'s `acquireToken`, which is coalesced per `(projectId, sorted scopes)` and never keeps module-level mutable state across calls. Four distinct callers drive it, each representing a different "state":

```
[No connection]
    |  connect() (connection.ts)
    |  acquireToken({interactive:true})  -> prompt:'consent', no hint
    v
[Connected, token cached]  <---------------------------------------------+
    |                                                                    |
    | token missing/expired                                              | success
    v                                                                    |
[Silent refresh attempt] -- acquireToken({interactive:false, hint:email})+
    |  triggered by 3 independent call sites:
    |   (a) http.ts 401 handler        -> refreshSilently, retry original request ONCE
    |   (b) refresh.ts warmUpIfNeeded  -> refreshSilently, proactive, background
    |   (c) refresh.ts (no fetchEmail) -> plain acquireToken fallback, background only
    |
    +-- GIS error / no token -----------------> NeedsReauthError
    +-- GIS returns token for the RIGHT email -> [Connected, token cached]
    +-- GIS returns token for the WRONG email -> clearToken(); WrongAccountError
```

Concretely, by module:

- **`token.ts`** is the only place that talks to GIS's `initTokenClient`. It does not know about "wrong account" — it just returns whatever token GIS hands back for the requested `(scopes, prompt, hint)`.
- **`connection.ts`**'s `refreshSilently` is the *only* place that adds wrong-account verification: after `acquireToken({interactive:false, hint:expectedEmail})` resolves, it calls the injected `fetchEmail(token.accessToken)` and compares the result against `expectedEmail`. Mismatch → `clearToken()` then throw `WrongAccountError`; match → return the token.
- **`http.ts`**'s `driveFetch`/`performFetch` is the 401 path: on a first 401 (not already a retry, not an interactive call), it clears the token and, if a `fetchEmail` was supplied and a connection's email is known, calls `refreshSilently`; otherwise falls back to a bare `acquireToken`. It retries the original request exactly once (`isRetryAfter401` flag) with whatever token comes back. A second 401, or any 401 on an interactive call, throws `NeedsReauthError` without retrying again. A `WrongAccountError` from `refreshSilently` is re-thrown as-is rather than being swallowed into `NeedsReauthError`.
- **`refresh.ts`**'s `warmUpIfNeeded` is the proactive path: fired from `visibilitychange`→`visible` and `pageshow`(persisted, not hidden) listeners attached by `activate()`. It only acts if a `conn` record exists **and** the cached token is missing or within `REFRESH_BUFFER_MS` (5 minutes) of `expiresAt`. When a `fetchEmail` is configured it goes through `refreshSilently` (so wrong-account detection also covers this path); otherwise it falls back to a bare `acquireToken`. It never *starts* a new attempt while the document is hidden — visibility is checked before it is ever called, so an attempt already in flight from before the tab hid is left to finish on its own.
- **`index.ts`**'s top-level `activate()` layers one global listener pair over `refresh.ts`'s per-call logic: it tracks every `projectId` ever passed to `.project(id)` in a `Set` and, on each visibility/pageshow event, calls `warmUpIfNeeded` for all of them (read live at fire time, so late-registered projects are still covered).

Wrong-account detection therefore covers exactly two silent paths — the 401-retry-once in `http.ts` and the proactive warm-up in `refresh.ts`/`index.ts` — both of which are wired through `refreshSilently`. It does **not** cover the interactive `connect()` path (a user consenting is trusted at face value) nor any refresh path where the caller omitted `fetchEmail` (the `refresh.ts` fallback branch and any hand-rolled use of `acquireToken` directly).

## 5. Known limitations / accepted tradeoffs

- **`reconcile()` degrades to a no-op** where `indexedDB.databases()` is unsupported (Firefox, older Safari at time of writing). On those browsers, orphaned per-project auth databases from deleted projects are never automatically reclaimed unless the app calls `dropProject(id)` eagerly when it deletes the project — `reconcile()` is a safety net, not the primary cleanup mechanism.
- **`files.ts`'s `read()` returns `null` on 404**, and that single value conflates two different situations: a genuinely wrong/nonexistent `fileId`, and a file that exists but that the currently-authenticated account cannot see (e.g. connected as the wrong Google account). The library cannot distinguish these — Drive itself returns an identical 404 for both — so callers that want to give an honest error message need to account for both cases themselves.
- **Wrong-account detection is not universal.** As detailed in §4, it is implemented once, inside `connection.ts`'s `refreshSilently`, and is only reached via two call sites: the 401-triggered silent refresh in `http.ts`, and the proactive warm-up in `refresh.ts` (when a `fetchEmail` resolver is supplied — `index.ts` always supplies one). It is **not** checked on the interactive `connect()` path, and the `refresh.ts` fallback branch that calls `acquireToken` directly (used only when no `fetchEmail` is configured) bypasses it entirely. A non-401 Drive call that succeeds against a token silently swapped to the wrong account (rather than expiring first) would not be caught until some later 401 or explicit `getConnection()`/email check.
- **Cross-tab token sharing is best-effort, not a guarantee.** `notifyExternalTokenRefresh` (§4, decision #31) only ever skips ONE subsequent GIS round-trip per `token` broadcast received — a one-shot flag, not a durable "this project is externally fresh" cache. If two tabs both attempt a refresh in the same narrow window, both can still end up making their own GIS calls.
- **`ensureFolderPath()`'s root-level lookup has no anchor.** Because the library only holds the `drive.file` scope, the first path segment is searched for by name/mimeType with no `in parents` constraint (every subsequent level is unambiguous, anchored to the previous level's id). Two folders with the same name at the top level anywhere the app can see are indistinguishable to this lookup; the first match wins.
