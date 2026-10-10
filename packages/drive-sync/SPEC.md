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

const dispose = drive.activate();               // attach visibility/pageshow/focus listeners
await drive.reconcile(knownProjectIds);          // drop orphaned per-project auth DBs

const p = drive.project(projectId);
await p.connect();                               // interactive; prompt:'consent'
const conn = await p.getConnection();            // { email, needsReauth, expiresAt } | null
const snap = p.getConnectionSync();            // Connection | null, synchronous, referentially stable
const unsub = p.subscribeConnection(() => {}); // fires when the snapshot reference changes

const picked = await p.pickFile({ apiKey: PICKER_API_KEY, appId: GCP_PROJECT_NUMBER });  // file-selection via Google Picker
const folderId = await p.ensureFolderPath();
const token = await p.getAccessToken();          // raw token for advanced/custom Picker wiring; pickFile() is the preferred path for most uses
const files = await p.files.list({ folderId });
const text = await p.files.read(fileId);         // string | Blob | null (null on 404)
const ref = await p.files.write({ folderId, name: 'x.json', content, mimeType: 'application/json' });
await p.permissions.grant({ fileId, type: 'user', role: 'writer', emailAddress: 'a@b.com' });
const full = await p.calendar.fullSync({ timeMin, timeMax }); // { events, nextSyncToken }
const delta = await p.calendar.syncChanges({ syncToken: full.nextSyncToken }); // { events, deletedIds, nextSyncToken }

await p.disconnect();
await drive.dropProject(projectId);
dispose();
```

`createDriveSync()` itself attaches no listeners and makes no network calls. Every Drive-op call site accepts an optional `{ interactive?: boolean }` (default `false`) and resolves its own token internally — no caller ever threads a token or a `projectId` string into an HTTP call by hand.

Files implementing the surface: `index.ts` (factory + `ProjectHandle`/`FilesHandle`/`PermissionsHandle`/`CalendarHandle`, plus `getConnectionSync`/`subscribeConnection`), `connection.ts` (`connect`/`getConnection`/`disconnect`/`refreshSilently`/`getAccessToken`), `files.ts`, `permissions.ts`, `calendar.ts` (read-only Calendar events — see §2a), `reconcile.ts`, `refresh.ts` (`activate`/warm-up), `picker.ts` (Google Picker integration), `errors.ts` (typed error classes, incl. `RefreshDeferredError`), `active.ts` (`isAppActive`), `types.ts` (`DriveSyncOptions` incl. `additionalScopes`, `Connection`, `StoredToken`, `FileRef`, `DrivePermission`, `CallOptions`, `CalendarEvent`, `CalendarEventDateTime`, `ListEventsOptions`).

`getAccessToken()` is the one deliberate exception to `Connection` never exposing secret material (types.ts): it exists solely so an app can feed the token to Google Picker (`setOAuthToken()`), which runs outside this library's control and has no other way to read it. Reuses a cached token while it has more than 5 minutes left; otherwise acquires one (interactive by default, since callers use this to drive a UI the user is actively interacting with).

### Connection snapshot

`index.ts` holds one in-memory `Connection | null` per `projectId`, in a `snapshotStores` Map inside the `createDriveSync` closure (alongside `trackedProjectIds`) — one `ConnectionSnapshotStore` (`connectionSnapshot.ts`) per project, created lazily on first access. Each store shallow-compares the incoming `Connection` on `email`/`needsReauth`/`expiresAt` before replacing its held reference, so `get()` returns a referentially-stable value suitable for `useSyncExternalStore`.

`null` from `getConnectionSync()` is ambiguous by design: it means either "disconnected" or "not yet hydrated" (the first background re-read from IndexedDB hasn't resolved). Callers cannot distinguish the two from the return value alone.

The snapshot is (re-)read from IndexedDB via `getConnection()` in several places, all but one of them fire-and-forget:

- **Lazily, on first access** — the first call to `getConnectionSync()` or `subscribeConnection()` for a project kicks off a `void`-ed re-read.
- **On a background warm-up** — `refresh.ts`'s `warmUpIfNeeded`, run from `activate()`'s visible-and-focused `visibilitychange`/persisted-`pageshow` handlers and its `focus` re-check handler.
- **On a cross-tab `logout`/`token` broadcast** — `handleBroadcast` re-reads the snapshot for the affected project. This only fires while `activate()` has been called (broadcast listening starts there).
- **For every tracked project, at `activate()` itself** — so already-registered projects get an immediate re-read when activation starts.

**The one exception:** after `connect()`/`disconnect()`, the re-read is `await`ed *before* the call resolves. This is the one place callers can rely on synchronous-after-await freshness — the moment `await p.connect()` (or `disconnect()`) returns, `p.getConnectionSync()` already reflects the new state. Every other re-read above is intentionally fire-and-forget, since nothing is awaiting them to observe the snapshot synchronously.

One behavioral consequence worth calling out: because the broadcast handler re-reads on `logout`, a `disconnect()` in one tab becomes observable to `subscribeConnection()` listeners in every other open tab — a capability the async-only `getConnection()` never had (nothing pushes to it).

## 2. The 41 resolved design decisions

**Bugs fixed (both source apps carried these):**

1. **Per-request token client, not a module singleton** — `token.ts`'s `acquireToken`/`acquireTokenUncoalesced` creates a fresh `initTokenClient` on every call; nothing closes over the first call's `projectId`.
2. **Scope honored on every call** — the fresh client is configured with `opts.scopes.join(' ')` per call, not baked in once at init.
3. **In-flight coalescing keyed by `(projectId, sorted scopes, interactive)`** — `token.ts`'s `coalesceKey` + `inFlight` map; concurrent calls for different projects/scopes never collide, and a user-initiated `connect()` is never handed the outcome of an in-flight silent refresh (which would settle the click with no OAuth flow shown).
4. **No clobbered resolvers** — `resolve`/`reject` are captured in each call's own `Promise` closure (`acquireTokenUncoalesced`), never stored on a module-level variable.
5. **Real expiry** — `persistTokenResponse` reads `response.expires_in` and computes `Date.now() + expiresIn * 1000`; no hardcoded `3600`.
6. **Every GIS request is time-bounded** — GIS settles a request only via `callback`/`error_callback`, and sometimes fires neither; `requestGisToken` rejects with `NeedsReauthError` (`reason: 'gis_timeout'`) after 5min interactive / 10s silent / 4s per recovery probe, so a request that is never answered cannot pin `inFlight` forever and kill every later retry.
7. **`grantedScopes` recorded** — `persistTokenResponse` splits `response.scope` and stores it on the token; `connection.ts`'s `connect()` also copies it onto the durable `ConnRecord`.
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
33. **No timer; warm-up only while visible and focused** — `index.ts`'s `activate()` attaches `visibilitychange`, `pageshow`, and `focus` listeners only when called (none at import time). A `visibilitychange` warm-up requires `document.visibilityState === 'visible'` and `document.hasFocus()`. A `pageshow` warm-up additionally requires `event.persisted`, then the same visible-and-focused check. If either event arrives while the visible page is unfocused, the `focus` listener re-checks and warms once the page gains focus; it never warms while hidden. `warmUpIfNeeded` only fires if a connection exists **and** the token is missing or within a 5-minute buffer (`REFRESH_BUFFER_MS`) of expiry. Failed warm-ups stay silent and never start interactive OAuth: their token request is always non-interactive (`prompt:'none'`). `index.ts` also layers a `trackedProjectIds` Set so one global listener set drives warm-ups for every project ever passed to `.project(id)`.
34. **`interactive` option, default `false`** — every `BaseCallOptions`-shaped call in `files.ts`/`permissions.ts`/`http.ts` defaults `interactive` to falsy; a non-interactive call with no usable token throws `NeedsReauthError` rather than silently prompting.
35. **Google Picker integration** — `picker.ts`'s `pickFile` accepts an `apiKey` and an `appId` (the OAuth client's Cloud project number) per-call (not stored in `DriveSyncOptions`); `appId` is mandatory because drive-sync holds only a `drive.file`-scoped token and Picker rejects a scoped session it cannot attribute to an app — omitting it makes Picker drop the OAuth token, show its own sign-in prompt, and fail with "The API developer key is invalid"; `index.ts` and `connection.ts` resolve the token, but `picker.ts` only ever sees a plain string token to avoid secret exposure. Script loading is cached at module level to avoid repeated GIS-loader calls. On user cancel, `PickerCancelledError` is thrown; on success, `FileRef` is returned. Drive scope prerequisites and token refresh are handled transparently (`picker.ts` takes the token and makes the Picker call; no token-boundary complexity leaks to callers).

36. **`list()` returns `modifiedTime`** — `files.ts`'s `list()` requests `modifiedTime` alongside `id,name,mimeType,version` (same field `fetchRemoteVersion` already fetches per-file for `status()`); `FileRef.modifiedTime` (`types.ts`) is optional since older/unfetched responses may omit it.

37. **`ensureFolderPath()` supports optional `subPath` for nested folder navigation** — `files.ts`'s `ensureFolderPath` now accepts an optional `subPath: string[]` parameter. When `subPath` is omitted, it resolves the full `folderPath` from factory options (original behavior). When provided, `subPath` is resolved relative to the folder resolved by the full `folderPath`, allowing nested folder creation/navigation without changing the factory `folderPath`. Multiple concurrent calls for the same path use "oldest-wins" semantics: if two tabs both call `ensureFolderPath()` for the same path simultaneously, the first successful create (or find, if the path already exists) wins; the second call reuses the result. This prevents race-condition folder duplication during concurrent tab operations.

38. **`files.update()` provides metadata-only, baseline-preserving updates** — `files.ts` now exports an `update()` method that rewrites a file's metadata (name, description, mimeType, etc.) without modifying its content or version history. The update is guaranteed to preserve the file's baseline content: if a concurrent write to the same file completes between the read and update, the `update()` call will fail with a conflict error rather than silently clobbering the concurrent change. This gives apps a way to rename/reclassify a file after upload without risking accidental content loss. The method is content-agnostic, accepting only metadata fields and refusing any content-bearing parameter.

39. **Server-facilitated token exchange is opt-in via `tokenExchangeUrl`** — `DriveSyncOptions.tokenExchangeUrl` (`types.ts`). When absent, every path (`connect()`, refresh, `disconnect()`) is the legacy GIS implicit-token flow, unchanged. When set, `connection.ts`'s `connect()` branches to `connectViaEnvelope`: `gis.ts`'s `acquireAuthCode` runs GIS `google.accounts.oauth2.initCodeClient` (popup) to get a one-time authorization **code** — no `redirect_uri`, no `state`, no `prompt` knob — then `envelope.ts`'s `postExchange`/`postExchangeWithRetry` does `POST {tokenExchangeUrl}` with `{ code }` (`Content-Type: application/json`, no credentials, no custom headers) and parses a `{ envelope }` response. The whole `Envelope` (`{ v: 2, guid, payload, sig }`, `types.ts`) is persisted verbatim under a new `envelope` key in the per-project `auth` store; the normal `token` record is derived from `payload` via `deriveToken`. The external request/response contract is the callback API doc at `https://open-webapp.duckdns.org/callback-api.md`.

40. **`refreshEnvelope` — freshness-gated, coalesced, cross-tab envelope replay** — `envelope.ts`'s `refreshEnvelope` is the refresh path when `tokenExchangeUrl` is set; `acquireToken`/GIS is never reached, so no popup can appear. It (1) drains any cross-tab envelope-refresh signal for the project, (2) reads the stored envelope — absent envelope → `NeedsReauthError` (`reason: 'exchange_failed'`), (3) if `payload.expiry_date` is still outside the `REFRESH_BUFFER_MS` (5-minute) window, returns the derived token with **no network call**, (4) otherwise replays the stored envelope byte-for-byte: `POST {tokenExchangeUrl}` with `{ envelope }`, persists the returned envelope + derived token, and fires a cross-tab `token` broadcast. Concurrent calls for the same `projectId` are coalesced onto one in-flight promise (`inFlightEnvelope` map, mirroring `token.ts`'s `inFlight`).

41. **Envelope error mapping, opaque `sig`, no schema bump** — `envelope.ts` maps exchange failures onto typed reauth reasons: `410` → clear conn+token+envelope, then `NeedsReauthError` (`reason: 'refresh_token_revoked'`, surfaced internally as the distinguishable `EnvelopeRevokedError` subclass); `502` / other `5xx` / network throw / unparseable body → up to two retries (500ms, 1500ms) then `NeedsReauthError` (`reason: 'exchange_unavailable'`); other non-2xx (`400`/`401`/`404`/`403`/`409`) → `NeedsReauthError` (`reason: 'exchange_failed'`), no retry. The envelope's `sig` is a server signature that is **never** verified client-side — the structure is treated as fully opaque and only `payload` is read. The `envelope` key is added to the existing `auth` store with **no IndexedDB version bump** (still version 1).

42. **`list()` passes through `thumbnailLink` + `imageMediaMetadata`, unfiltered and verbatim** — `files.ts`'s `list()` extends the same `fields` mask touched in #36's `modifiedTime` change to also request `thumbnailLink` and `imageMediaMetadata(width,height,rotation)`; `FileRef` (`types.ts`) gains three optional fields — `mimeType?` (already fetched, previously just untyped), `thumbnailLink?`, and `imageMediaMetadata?: { width?; height?; rotation? }` — all `fields`-gated and may be absent on older or partial responses. `list()` stays unfiltered: it returns every file of any MIME type with no `image/` check and no opt-in flag, and `thumbnailLink` is passed through exactly as Drive returns it — no blob fetch, no URL rewrite, no `=s220` size munging, and no `files.thumbnail()` helper. Caveat: `thumbnailLink` is a short-lived URL (good for only ~hours) that can require the browser to be carrying Google auth context for the file's owning account, so a cross-origin bare `<img src>` may 403; rendering is the consuming app's responsibility, and it can fall back to `getAccessToken()` + fetch-to-blob itself. (Label is `42` though this is only the 41st entry — the section carries a duplicate `7.` label and a merged `25–27.` entry, so the labels have always run one ahead of the item count; no existing entry is renumbered.)

43. **Synchronous connection snapshot, per project** — `index.ts`'s `ProjectHandle` gains `getConnectionSync(): Connection | null` and `subscribeConnection(cb): () => void`, backed by a new `connectionSnapshot.ts` (`createConnectionSnapshotStore`) held per `projectId` in the `snapshotStores` Map alongside `trackedProjectIds`. The store shallow-compares `email`/`needsReauth`/`expiresAt` so its reference stays stable across no-op re-reads (`useSyncExternalStore`-friendly). It is populated lazily on first access, kept warm by the same warm-up/broadcast/`activate()` paths that already existed, and — the one synchronous-after-await guarantee in the package — re-read and `await`ed to completion inside `connect()`/`disconnect()` before those calls resolve. A side effect: cross-tab `logout` broadcasts now push a visible state change to `subscribeConnection()` listeners, which the async-only `getConnection()` never did.

## 2a. Configurable scopes and read-only Calendar events (v0.9.0)

**`additionalScopes` option.** `DriveSyncOptions.additionalScopes?: string[]` (`types.ts`) lets a consumer request extra OAuth scopes alongside the library's own Drive scopes (`REQUIRED_SCOPES` — `drive.file` + `userinfo.email`, `files.ts`). `createDriveSync` computes `EFFECTIVE_SCOPES = [...REQUIRED_SCOPES, ...(options.additionalScopes ?? [])]` once, and threads that single array into every scope-consuming call site: `connect()`, `getConnection()`, `getAccessToken()`, `pickFile()`, the connection-snapshot re-read, `refresh.ts`'s `warmUpIfNeeded` (via a new `scopes` field on `ActivateOptions`), and every `files.ts`/`permissions.ts` call (via a new `requiredScopes: string[]` field on their shared `BaseCallOptions`, populated from `index.ts`'s per-project `base` object). **Backward compatibility guarantee:** when `additionalScopes` is omitted or empty, `EFFECTIVE_SCOPES` is referentially the same value set as the old bare `REQUIRED_SCOPES` constant, so every request this library makes is byte-identical to before this option existed. `connection.ts`'s existing scope-coverage check (`needsReauth`, §"resolved decisions" #19-ish / `connection.ts:233`) means a token missing a newly-added scope is genuinely treated as needing reauth, not silently ignored.

**Calendar capability.** `ProjectHandle.calendar.listEvents({ timeMin, timeMax }, callOpts?)` (new `calendar.ts`, wired onto `ProjectHandle` in `index.ts` alongside `files`/`permissions`, sharing the same per-project `base` object and therefore the same `EFFECTIVE_SCOPES`) issues `GET https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=...&timeMax=...&singleEvents=true&orderBy=startTime` through the same `driveFetch` (`http.ts`) every Drive call uses — `driveFetch` is generic over the request URL/host and only hardcodes Drive-specific behavior in its error-message text, so it needed no changes to serve a non-Drive Google API. The library hardcodes no date range; the caller supplies `timeMin`/`timeMax` as ISO 8601 strings. Read-only: no create/update/delete Calendar operation exists in this package. Every event Google returns in range is mapped and returned unfiltered, in Google's own `orderBy: startTime` order — no RSVP filtering or declined-event dropping happens in the library; that is an app-side decision.

Like every `files.*`/`permissions.*` call, `listEvents` defaults `interactive` to `false` (NOT `getAccessToken()`'s interactive-by-default exception) — a background calendar poll never triggers a consent popup. Pass `{ interactive: true }` to allow one.

**Normalized `CalendarEvent` shape** (`types.ts`):

```ts
interface CalendarEventDateTime {
  dateTime?: string; // present for timed events
  date?: string;     // present for all-day events (YYYY-MM-DD), mutually exclusive with dateTime
  timeZone?: string;
}
interface CalendarEvent {
  id: string;
  summary: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  isAllDay: boolean; // true iff start.date is present with no start.dateTime
  selfResponseStatus: 'accepted' | 'tentative' | 'needsAction' | 'declined';
  joinUrl: string | null;
  organizer: { displayName?: string; email?: string; self: boolean };
  htmlLink: string;
  calendarId: string; // the calendarId passed to listEvents, or 'primary'; NOT resolved to an email (0.10.0, required)
}
```

**Multiple calendars (v0.10.0).** `ListEventsOptions.calendarId?: string` (default `'primary'`) selects the calendar; it is `encodeURIComponent`-ed into `/calendars/{id}/events`. `ProjectHandle.calendar.listCalendars(callOpts?)` issues `GET /calendar/v3/users/me/calendarList?maxResults=250`, following `nextPageToken` until exhausted (any failing page rejects the whole call, no partial results), and returns `CalendarInfo[]` (`id`, `summary`, `primary`, `accessRole`, optional `backgroundColor`/`foregroundColor`/`selected`). Same `calendar.readonly` scope and same non-interactive default as `listEvents`. `CalendarEvent.calendarId` is now required: hand-built `CalendarEvent` literals (tests/mocks) must add it.

**`selfResponseStatus` derivation** (`calendar.ts`'s `deriveSelfResponseStatus`): if the raw event has an `attendees` array, find the entry with `self === true` and pass its `responseStatus` through verbatim (Google's enum already matches this type; defaults to `'needsAction'` if a non-empty `attendees` array somehow has no self entry). If there is no `attendees` array at all (a self-only event, or an organizer with nothing to respond to), the status is `'accepted'`.

**`joinUrl` derivation** (`calendar.ts`'s `extractJoinUrl`), in precedence order: (1) `event.hangoutLink` if present; (2) the first `event.conferenceData.entryPoints` entry with `entryPointType === 'video'`, its `uri`; (3) a best-effort regex scan, `event.location` then `event.description`, for the first URL matching `zoom.us`, `meet.google.com`, or `teams.microsoft.com` (may false-negative on oddly formatted text — accepted, since the two structured sources above cover the common case); (4) `null` if nothing matches.

**All-day events.** `isAllDay = Boolean(raw.start?.date && !raw.start?.dateTime)`. The mapper (`calendar.ts`'s `mapEvent`) reads `start.date`/`end.date` when present and never assumes `start.dateTime` exists — an all-day event's `dateTime` field stays `undefined` on the normalized `CalendarEvent`, it is never coerced to `''` or allowed to throw.

## 2b. Incremental calendar sync (v0.12.0)

**API.** `ProjectHandle.calendar` adds two methods, both accepting optional `callOpts` as their second argument:

- `fullSync({ calendarId?: string, timeMin: string, timeMax: string }, callOpts?)` returns `{ events: CalendarEvent[], nextSyncToken: string }`. The required time bounds seed the full sync; `calendarId` defaults to `'primary'`.
- `syncChanges({ calendarId?: string, syncToken: string }, callOpts?)` returns `{ events: CalendarEvent[], deletedIds: string[], nextSyncToken: string }`. `events` contains changed/new events; `calendarId` defaults to `'primary'`.

**Requests and pagination.** Both methods use `singleEvents=true`, `maxResults=250`, and follow every `nextPageToken`. `fullSync` sends the supplied time bounds and no `orderBy`. Incremental requests send the raw `syncToken` and no `timeMin`, `timeMax`, or `orderBy`, consistent with Google's sync-token parameter restrictions. Both require `nextSyncToken` on the final page; a missing final token throws `DriveSyncError` rather than returning an incomplete sync result.

**Caller-owned token flow.** The raw Calendar sync token is opaque and owned by the caller, separately for each `calendarId`; the library does not persist it or automatically resync. Start with `fullSync`, replace the calendar's cache with its events, and retain its token. Then call `syncChanges` with that calendar's token, apply `deletedIds` and upsert changed/new events, and only then replace the stored token with `nextSyncToken`.

**Deleted events and recurring instances.** In incremental sync, `syncChanges` filters cancelled event stubs before event mapping, so they do not require `start`/`end` or appear in normalized `events`; their ids are returned in `deletedIds`. With `singleEvents=true`, recurring-event ids are instance ids, not recurring-series ids; delete the matching cached instance by id.

**410 recovery.** A Calendar HTTP 410 on any page rejects the whole call with `SyncTokenExpiredError`, which extends `DriveSyncError` with `status: 410` and `reason: 'sync_token_expired'`. Other errors retain their existing behavior. The caller catches only `SyncTokenExpiredError`, runs a new `fullSync` for that calendar and time window, and replaces the entire calendar cache and token after success; there is no automatic full-sync fallback or partial result to apply.

These methods use the same `calendar.readonly` scope and non-interactive-by-default authentication as the existing Calendar methods. The normalized `CalendarEvent` shape is unchanged. Mocked tests can verify request parameters and token handling, but cannot verify Google's live acceptance of the `singleEvents=true` + `syncToken` combination.

**BREAKING — `listEvents` pagination:** in v0.12.0, `listEvents` follows all pages rather than returning only the first page. Consumers now receive the complete event list, potentially more events than before; any failing page rejects the whole call rather than returning partial results.

## 3. Storage layout

Each project gets its own IndexedDB database: **`owa-drive-{appId}-{projectId}`**, version 1, containing one object store, `auth` (`storage.ts`). The store holds up to three keys (`conn`/`token` always; `envelope` only in server-facilitated token-exchange mode):

| Key | Shape | Lifetime |
|---|---|---|
| `conn` | `{ email, grantedScopes: string[], connectedAt: number }` | Durable — survives token expiry. Written by `connect()`. Cleared only by `disconnect()` (and by the `410` envelope-revoked path). |
| `token` | `{ accessToken, expiresAt, grantedScopes: string[] }` | Ephemeral. Written by `persistTokenResponse()` on every successful token acquisition, and by `refreshEnvelope`/`connectViaEnvelope` (derived from the envelope `payload`) in token-exchange mode. Cleared on 401 (`http.ts`), on `ScopeInsufficientError` (`http.ts`), on a detected wrong-account mismatch (`connection.ts`'s `refreshSilently`), on the `410` envelope-revoked path, and by `disconnect()`. |
| `envelope` | `{ v: 2, guid, payload, sig }` (the whole opaque `Envelope`) | Present only when `tokenExchangeUrl` is configured. Written verbatim by `connectViaEnvelope()` and replaced on every successful `refreshEnvelope()`. Cleared by `disconnect()` (unconditionally) and on the `410` envelope-revoked path. Never version-bumps the store. |

Open handles are cached in-process in a `Map<string, Promise<IDBPDatabase>>` keyed by `${appId}:${projectId}` (`storage.ts`'s `dbCache`), so repeated calls for the same project reuse one connection. `evictDbHandle` closes and drops that cache entry without deleting the underlying database — the deletion itself only happens in `reconcile.ts`.

Two things trigger deleting the whole per-project database:

- **`drive.dropProject(projectId)`** — the eager, app-driven path (e.g. called when a project is deleted in the host app).
- **`drive.reconcile(knownProjectIds)`** — the safety net, run at boot: enumerates every `owa-drive-{appId}-*` database via `indexedDB.databases()` and deletes any whose trailing projectId is not in the supplied set. No-ops (does not throw) where `indexedDB.databases()` is unsupported.

Nothing in this schema stores a Drive `folderId` or `fileId` — those stay app-side by design (#28 above).

## 4. Refresh state machine

Token acquisition always funnels through `token.ts`'s `acquireToken`, which is coalesced per `(projectId, sorted scopes, interactive)` and never keeps module-level mutable state across calls. Four distinct callers drive it, each representing a different "state":

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
- **`token.ts`'s `popup_closed` handling** is deliberately two-stage, because GIS reports `popup_closed` for *completed* sign-ins as well as cancelled ones:
  1. **Grace window** (`POPUP_CLOSED_GRACE_MS`, 2000ms) — wait for a success `callback` that is merely late to still win.
  2. **Completed-grant probe** (interactive path only) — if no token arrived, issue one `prompt:'none'` request before giving up. A completed consent leaves a live grant at Google, so this resolves with no popup; a cancelled sign-in leaves none, and the original `NeedsReauthError{reason:'popup_closed'}` is rethrown unchanged (never the probe's own error).

  Stage 2 exists because the success `callback` sometimes never arrives *at all* for a completed sign-in, which no grace window can fix. The silent path skips the probe — it is already a `prompt:'none'` request.
- **`connection.ts`**'s `refreshSilently` is the *only* place that adds wrong-account verification: after `acquireToken({interactive:false, hint:expectedEmail})` resolves, it calls the injected `fetchEmail(token.accessToken)` and compares the result against `expectedEmail`. Mismatch → `clearToken()` then throw `WrongAccountError`; match → return the token.
- **`http.ts`**'s `driveFetch`/`performFetch` is the 401 path: on a first 401 (not already a retry, not an interactive call), it clears the token and, if a `fetchEmail` was supplied and a connection's email is known, calls `refreshSilently`; otherwise falls back to a bare `acquireToken`. It retries the original request exactly once (`isRetryAfter401` flag) with whatever token comes back. A second 401, or any 401 on an interactive call, throws `NeedsReauthError` without retrying again. A `WrongAccountError` from `refreshSilently` is re-thrown as-is rather than being swallowed into `NeedsReauthError`.
- **`refresh.ts`**'s `warmUpIfNeeded` is the proactive path: fired only after `index.ts`'s `activate()` verifies the document is visible and focused on `visibilitychange`, persisted `pageshow`, or a later `focus` re-check. It only acts if a `conn` record exists **and** the cached token is missing or within `REFRESH_BUFFER_MS` (5 minutes) of `expiresAt`. When a `fetchEmail` is configured it goes through `refreshSilently` (so wrong-account detection also covers this path); otherwise it falls back to a bare, non-interactive `acquireToken`. A failed warm-up is swallowed, remains silent, and never starts interactive OAuth. It never *starts* a new attempt while the document is hidden — visibility is checked before it is ever called, so an attempt already in flight from before the tab hid is left to finish on its own.
- **`index.ts`**'s top-level `activate()` layers one global listener set over `refresh.ts`'s per-call logic: it tracks every `projectId` ever passed to `.project(id)` in a `Set` and, on each eligible visible-and-focused visibility/pageshow/focus event, calls `warmUpIfNeeded` for all of them (read live at fire time, so late-registered projects are still covered).

**Envelope branch (server-facilitated token-exchange mode).** When `tokenExchangeUrl` is configured, `connection.ts`'s `refreshSilently` short-circuits to `envelope.ts`'s `refreshEnvelope` and the entire GIS state machine above is bypassed — no `initTokenClient`, no `prompt:'none'`, no popup. `refreshEnvelope` does a local freshness check against the stored envelope's `payload.expiry_date` (± `REFRESH_BUFFER_MS`); if fresh it returns the derived token with no network call, otherwise it echoes-or-replays the stored envelope via `POST {tokenExchangeUrl}` with `{ envelope }`, persists the new envelope + derived `token`, and broadcasts a cross-tab `token` message. A `410` (server-side refresh token revoked) clears `conn` + `token` + `envelope` and throws `NeedsReauthError` (`reason: 'refresh_token_revoked'`); `502`/`5xx`/network → retried then `exchange_unavailable`; a missing envelope or other `4xx` → `exchange_failed`. In this mode there is no wrong-account check (the server owns the identity) and the interactive `connect()` path is `connectViaEnvelope` (auth-code leg + `POST { code }`) rather than an implicit token grant.

Wrong-account detection therefore covers exactly two silent paths — the 401-retry-once in `http.ts` and the proactive warm-up in `refresh.ts`/`index.ts` — both of which are wired through `refreshSilently`. It does **not** cover the interactive `connect()` path (a user consenting is trusted at face value) nor any refresh path where the caller omitted `fetchEmail` (the `refresh.ts` fallback branch and any hand-rolled use of `acquireToken` directly).

## 4a. Inactive refresh gate (v0.11.0, BREAKING)

An app is **active** when `document.visibilityState === 'visible' && document.hasFocus()`; with no `document` (Node, workers) it is treated as active. The single helper is `active.ts`'s `isAppActive()`, used by both `index.ts` (warm-up listeners) and `http.ts`.

While inactive, a **non-interactive** call that would need a silent token refresh rejects immediately with `RefreshDeferredError` (`reason: 'refresh_deferred'`). Deferred paths in `driveFetch`: (1) no cached token or an expired/near-expiry one (legacy GIS acquire and envelope/`tokenExchangeUrl` refresh alike); (2) the 401 silent-refresh-and-retry, checked before `clearToken` so the stored token is untouched. A still-valid cached token keeps working while hidden. No GIS or token-exchange call is made, and stored connection/token/envelope are untouched; nothing is broadcast and no logout happens. `RefreshDeferredError` extends `DriveSyncError` and is deliberately NOT a `NeedsReauthError`: it means "later, not logout".

Interactive calls (`connect()`, `interactive: true`) are unchanged. There is no request queue or auto-retry: the deferred request is not replayed; on reactivation the existing visibility/pageshow/focus warm-up listeners refresh stale tokens, and the caller retries. In-flight GIS calls are not aborted.

**Breaking:** callers that previously got a silent refresh (or `NeedsReauthError`) while the tab was hidden now get `RefreshDeferredError` and must retry once active.

## 5. Known limitations / accepted tradeoffs

- **Inactive gate relies on `document.hasFocus()`**, which can be false while visible inside embedded iframes; such hosts see `RefreshDeferredError` on silent refreshes until focused. Callers that ignore `RefreshDeferredError` lose the request (no auto-retry).

- **`reconcile()` degrades to a no-op** where `indexedDB.databases()` is unsupported (Firefox, older Safari at time of writing). On those browsers, orphaned per-project auth databases from deleted projects are never automatically reclaimed unless the app calls `dropProject(id)` eagerly when it deletes the project — `reconcile()` is a safety net, not the primary cleanup mechanism.
- **`files.ts`'s `read()` returns `null` on 404**, and that single value conflates two different situations: a genuinely wrong/nonexistent `fileId`, and a file that exists but that the currently-authenticated account cannot see (e.g. connected as the wrong Google account). The library cannot distinguish these — Drive itself returns an identical 404 for both — so callers that want to give an honest error message need to account for both cases themselves.
- **Wrong-account detection is not universal.** As detailed in §4, it is implemented once, inside `connection.ts`'s `refreshSilently`, and is only reached via two call sites: the 401-triggered silent refresh in `http.ts`, and the proactive warm-up in `refresh.ts` (when a `fetchEmail` resolver is supplied — `index.ts` always supplies one). It is **not** checked on the interactive `connect()` path, and the `refresh.ts` fallback branch that calls `acquireToken` directly (used only when no `fetchEmail` is configured) bypasses it entirely. A non-401 Drive call that succeeds against a token silently swapped to the wrong account (rather than expiring first) would not be caught until some later 401 or explicit `getConnection()`/email check.
- **Cross-tab token sharing is best-effort, not a guarantee.** `notifyExternalTokenRefresh` (§4, decision #31) only ever skips ONE subsequent GIS round-trip per `token` broadcast received — a one-shot flag, not a durable "this project is externally fresh" cache. If two tabs both attempt a refresh in the same narrow window, both can still end up making their own GIS calls.
- **`ensureFolderPath()`'s root-level lookup has no anchor.** Because the library only holds the `drive.file` scope, the first path segment is searched for by name/mimeType with no `in parents` constraint (every subsequent level is unambiguous, anchored to the previous level's id). Two folders with the same name at the top level anywhere the app can see are indistinguishable to this lookup; the first match wins.

**Server-facilitated token-exchange mode (`tokenExchangeUrl` set):**

- **Orphaned server-side `<guid>/perm-token.json` is never cleaned up.** The exchange server persists one `refresh_token` file per envelope `guid`, and there is no revoke endpoint. `disconnect()` only revokes the current *access* token (killing the live grant); it cannot tell the server to delete the stored `refresh_token`. Every `connect()` that mints a new `guid` leaves the previous server-side record behind indefinitely.
- **A re-`connect()` may be un-refreshable server-side.** Google returns a `refresh_token` only on the *first* consent per (user, client), and GIS `initCodeClient` exposes no `prompt` knob to force re-consent. If a later `connect()` produces a fresh `guid` but Google returns no `refresh_token` for it, the server has nothing to replay and that envelope cannot be refreshed — the user is stuck on the access token's lifetime until a consent screen is shown by some other means.
- **The tester needs an Origin-spoof proxy.** The reference server's CORS allowlist is `https://notesdiary.github.io` and `https://open-webapp.github.io` only, with credentials disabled; `localhost` is not allowed. `apps/drive-sync-oauth-tester` therefore routes exchange requests through a Vite dev-server proxy that rewrites the `Origin` header to `https://open-webapp.github.io`. See `https://open-webapp.duckdns.org/callback-api.md` for the contract.
- **The server's `GOOGLE_REDIRECT_URI` is assumed to be `postmessage`.** Popup-mode code exchange (`initCodeClient` → `POST { code }`) only works if the server exchanges the code against `redirect_uri = 'postmessage'`. This is a server-side assumption that has not been verified against the deployed server; a mismatch would make `connectViaEnvelope` fail at the exchange step.
