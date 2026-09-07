# Plan: drive-sync server-facilitated OAuth token exchange

## Goal
Right now `@open-webapp/drive-sync` get Google token by itself in browser. Token die
after 1 hour, no refresh token, so user must click again. We add NEW opt-in path:
caller pass `tokenExchangeUrl`. When set, drive-sync use Google **auth-code** popup,
send code to already-live server `POST https://open-webapp.duckdns.org/callback`,
server give back signed opaque "Envelope". drive-sync store whole Envelope, replay it
byte-for-byte to server to get fresh access token. Server keep refresh token, client
never see it. When `tokenExchangeUrl` NOT set: nothing change, every old test still
pass, `envelope` storage key never touched.

## Scope
**In scope:**
- New `DriveSyncOptions.tokenExchangeUrl?: string`.
- New `Envelope` + `EnvelopePayload` TS types, exported from package root.
- New GIS auth-code leg (`initCodeClient` + `requestCode()`), popup mode.
- New `envelope` key in existing `auth` object store + `getEnvelope/setEnvelope/clearEnvelope`.
- New internal `refreshEnvelope(...)` with local freshness check, per-`projectId`
  coalescing, cross-tab storage-read-first, broadcast on new envelope.
- Envelope-mode branch (gated on `tokenExchangeUrl` presence) in: `connect`,
  `getAccessToken`, `disconnect`, `http.ts` 401 retry, `refresh.ts` warm-up,
  `index.ts` `activate()` visibility/pageshow.
- Error mapping (`410`, `502`, `400`/`401`/`404`, network) -> `NeedsReauthError` reasons + retry.
- Test doubles: extend `createGisFake` with `initCodeClient`; new `createTokenExchangeFake()`.
- New vitest specs for all envelope paths.
- `apps/drive-sync-oauth-tester`: `VITE_DRIVE_TOKEN_EXCHANGE_URL` env, Vite `/callback`
  Origin-spoof proxy, wiring, manual checklist.
- Docs: `SPEC.md` + `README.md` updates; `package.json` `0.5.7` -> `0.6.0`.
- Release tag `drive-sync-v0.6.0` per `CLAUDE.md`.

**Out of scope:**
- Any change to the deployed server or its CORS allowlist.
- Removing the legacy GIS-implicit (`initTokenClient`) code path — separate future cleanup.
- Migrating `notesdiary` / `open-webapp` consumer apps to set `tokenExchangeUrl`.
- `packages/project-sync/**`.
- Verifying server `sig` on the client (client treats envelope as opaque).
- IndexedDB schema version bump.

## Resolved decisions
No re-litigating these. Baked in verbatim from the design interview.

1. Opt-in only via `DriveSyncOptions.tokenExchangeUrl?: string`. Absent = today's
   `initTokenClient` implicit path, byte-for-byte unchanged, `envelope` storage key
   never touched, all existing tests pass unmodified. Both code paths coexist;
   dead GIS-implicit removal is a LATER separate cleanup, not this plan.
2. Auth leg = GIS `google.accounts.oauth2.initCodeClient({ client_id, scope:
   REQUIRED_SCOPES.join(' '), ux_mode: 'popup', hint?: existingConn.email, callback })`,
   then `requestCode()`, no `redirect_uri`, no `state`. Server's `GOOGLE_REDIRECT_URI`
   is `postmessage` (server-side assumption, documented as risk, not fixed here). App
   MUST be configured with the same `clientId` the server holds as `GOOGLE_CLIENT_ID`
   (client IDs aren't secret).
3. `connect()` on envelope mode: always fresh code flow -> new `guid`, prior envelope
   replaced, no already-connected short-circuit. Then `POST {tokenExchangeUrl}`
   `{ code }` -> persist whole envelope -> derive+persist `StoredToken` ->
   `fetchEmail(payload.access_token)` once -> persist `conn`. `fetchEmail`
   wrong-account compare is NOT added to this path (guid binds one server grant).
4. Storage: add a third key `envelope` to the existing `auth` store holding the
   verbatim envelope. New `storage.ts` helpers `getEnvelope/setEnvelope/clearEnvelope`.
   NO IndexedDB version bump. `token` key still written (derived) so
   `http.ts`/`getConnection`/Picker/cross-tab are untouched. Clearing: `disconnect()`
   clears conn+token+envelope; `http.ts` 401 clears token only; `410` clears
   conn+token+envelope.
5. `StoredToken` derivation from `payload`: `accessToken = payload.access_token`,
   `expiresAt = payload.expiry_date` (already epoch ms),
   `grantedScopes = payload.scope.split(' ').filter(Boolean)`.
6. New internal `refreshEnvelope({ appId, projectId, tokenExchangeUrl, logger })`:
   local freshness check first — if `Date.now() < payload.expiry_date -
   REFRESH_BUFFER_MS` (5 min, reuse existing buffer) return derived `StoredToken`
   with no network; else read stored envelope (none -> `NeedsReauthError`),
   `POST {tokenExchangeUrl}` `{ envelope }`, on 200 persist new envelope + derived
   token + `createBroadcast(appId).postToken(projectId)` + return; coalesced per
   `projectId` via the existing in-flight-map pattern; other tabs read storage
   before POSTing (extend `notifyExternalTokenRefresh` semantics to the envelope key).
7. Error mapping in `refreshEnvelope` + the code-exchange call: `410
   refresh_token_revoked` -> clear conn+token+envelope, throw
   `NeedsReauthError({ reason: 'refresh_token_revoked' })`. `502 google_unavailable`
   or a thrown/network fetch error -> 2 retries at 500ms then 1500ms, then
   `NeedsReauthError({ reason: 'exchange_unavailable' })`. `400`/`401`/`404` ->
   `NeedsReauthError({ reason: 'exchange_failed' })` + `logger.error`, no retry.
8. `http.ts` 401 on envelope mode: clear `token` key only -> `refreshEnvelope` ->
   retry original request once; second 401 or interactive -> `NeedsReauthError`,
   control flow otherwise unchanged. Branch on `tokenExchangeUrl` presence: set ->
   `refreshEnvelope`; unset -> today's `acquireToken`/`refreshSilently` path unchanged.
9. `refresh.ts` `warmUpIfNeeded` + `index.ts` `activate()` visibility/pageshow: when
   `tokenExchangeUrl` set, call `refreshEnvelope` instead of the GIS silent path;
   same gate (conn exists && token missing/within `REFRESH_BUFFER_MS` of expiry);
   never start while document hidden. All THREE legacy silent-refresh call sites
   (http 401, refresh warm-up, refresh no-`fetchEmail` fallback) get the
   `tokenExchangeUrl` branch.
10. `getAccessToken` (Picker raw-token path) on envelope mode: freshness-check ->
    `refreshEnvelope` if stale -> return `payload.access_token`. Never triggers
    interactive code flow (Picker requires an already-connected project).
11. `disconnect()` on envelope mode: keep the existing best-effort `revokeFn` wired,
    fed `payload.access_token` (revoking the access token kills the whole Google
    grant incl. refresh token -> server's stored copy goes dead). Then clear
    conn+token+envelope + broadcast logout. Network failure of revoke does not
    block disconnect.
12. Envelope HTTP calls: plain global `fetch` (like `fetchEmail`/`revokeToken`), NOT
    `driveFetch`. `Content-Type: application/json`, no credentials, no custom headers.
13. Client NEVER verifies `sig` — envelope is opaque: store, replay verbatim.
14. New `Envelope` + `EnvelopePayload` TS interfaces in `types.ts`, exported from
    package root (`index.ts` re-export).
15. `tokenExchangeUrl` threaded through `DriveSyncOptions` ->
    `connect`/`refresh`/`getAccessToken`/`disconnect`/http wiring exactly like
    `clientId` is today.
16. Testing: extend `createGisFake` to also stub `initCodeClient` (`requestCode()`
    fires callback with a canned `{ code }`), gated so implicit-path tests are
    unaffected. Add `createTokenExchangeFake()` to `./testing`: an installable
    `fetch` handler for `tokenExchangeUrl` that mints a valid HMAC-signed envelope
    (canonical JSON sorted-keys no-whitespace + base64url, from a test secret) and
    supports echo-if-fresh / refresh-if-stale plus on-demand `410`/`502`/error-shape
    responses. New vitest specs: connect code->envelope happy path; `refreshEnvelope`
    fresh-echo vs stale-refresh; `410` clears all three keys + throws; `502` retries
    then throws; `disconnect` revokes `payload.access_token`; all three call sites
    route by `tokenExchangeUrl`; per-`projectId` coalescing; legacy path unaffected.
17. `apps/drive-sync-oauth-tester` in scope: add `VITE_DRIVE_TOKEN_EXCHANGE_URL` env
    (wire `tokenExchangeUrl` into `createDriveSync` only when set); add a
    `vite.config.ts` `server.proxy` entry `'/callback' -> { target:
    'https://open-webapp.duckdns.org', changeOrigin: true, headers: { Origin:
    'https://open-webapp.github.io' } }` (localhost isn't on the server CORS
    allowlist; the proxy spoofs an allowed Origin server-side); default the env to
    `/callback` so it hits the proxy; existing GIS buttons keep working when the env
    var is absent; add a manual checklist. Do NOT add `.env.local.example` secrets —
    placeholders only.
18. Docs + release: bump `packages/drive-sync/package.json` `0.5.7` -> `0.6.0`
    (backward-compatible feature). Update `SPEC.md` (new resolved-decision entries,
    extend §4 state machine with the envelope branch, add §5 limitations: orphaned
    server `perm-token.json` never cleaned up; Google only returns `refresh_token`
    on first consent for a user+client and `initCodeClient` has no `prompt` knob so
    a re-`connect()` new-`guid` may be un-refreshable server-side; tester needs the
    Origin-spoof proxy). Add a `README.md` "Server-facilitated token exchange" usage
    block. After the worktree branch merges, create + push `git tag drive-sync-v0.6.0`
    per `CLAUDE.md` — explicit final task, not implicit.

## Server contract (authoritative — code against it, do NOT design it)
- `POST {tokenExchangeUrl}` — `Content-Type: application/json`, body EXACTLY one of
  `{ code }` (new grant) or `{ envelope }` (refresh). Response `200 { envelope: Envelope }`.
- `Envelope = { v: 2, guid: string(uuidv4), payload: { access_token: string,
  expiry_date: number /*epoch ms*/, token_type: 'Bearer', scope: string
  /*space-delimited*/ }, sig: string }`.
- `refresh_token` NEVER returned. Client stores whole envelope, replays byte-for-byte.
  Server echoes unchanged if `Date.now() < expiry_date - 60000`, else refreshes.
- No revoke endpoint. No cookies/bearer. Client never verifies `sig`.
- CORS allowlist: `https://notesdiary.github.io`, `https://open-webapp.github.io` only;
  credentials never enabled; localhost NOT allowed.
- Errors: JSON `{ error: { code, message } }`, branch on `code`. Relevant:
  `410 refresh_token_revoked`, `502 google_unavailable` (retryable),
  `400 malformed_request` / `code_or_envelope_required` / `code_and_envelope_exclusive`,
  `401 invalid_envelope_signature`, `404 unknown_guid`.
- Full doc: `https://open-webapp.duckdns.org/callback-api.md` (WebFetch only if needed).

## Affected files
- `packages/drive-sync/src/types.ts` — add `tokenExchangeUrl?` to `DriveSyncOptions`;
  add `Envelope`, `EnvelopePayload` interfaces.
- `packages/drive-sync/src/index.ts` — re-export `Envelope`/`EnvelopePayload`; read
  `options.tokenExchangeUrl`; thread it into `connect`, `disconnect`, `getAccessToken`,
  `driveFetch` wiring, and `warmUpIfNeeded` calls (both the local `runWarmUps` and any
  `ActivateOptions`).
- `packages/drive-sync/src/storage.ts` — add `ENVELOPE_KEY`; `AuthDbSchema` value union
  gains `Envelope`; `getEnvelope/setEnvelope/clearEnvelope`.
- `packages/drive-sync/src/envelope.ts` — NEW. `exchangeCode`, `replayEnvelope` (raw
  `fetch` POSTs), server-error parsing + mapping, retry/backoff helper, `deriveToken`,
  and the `refreshEnvelope` internal with freshness check + per-`projectId`
  in-flight-coalescing map + broadcast + externally-refreshed drain.
- `packages/drive-sync/src/token.ts` — extend `notifyExternalTokenRefresh` /
  `externallyRefreshed` semantics so an envelope-key cross-tab signal is consumable
  (or export a parallel `notifyExternalEnvelopeRefresh` + set — pick one, document it).
- `packages/drive-sync/src/connection.ts` — `ConnectOptions`, `GetAccessTokenOptions`,
  `DisconnectOptions` gain `tokenExchangeUrl?`; `connect`, `getAccessToken`,
  `disconnect` each branch on it.
- `packages/drive-sync/src/http.ts` — `DriveFetchOptions` gains `tokenExchangeUrl?`;
  `driveFetch` cached-token reuse unchanged; the token-acquire path and the 401 retry
  path branch on `tokenExchangeUrl` -> `refreshEnvelope`.
- `packages/drive-sync/src/refresh.ts` — `ActivateOptions` gains `tokenExchangeUrl?`;
  `warmUpIfNeeded` branches on it -> `refreshEnvelope`.
- `packages/drive-sync/src/gis.ts` — confirm `initCodeClient` sits on the same
  `google.accounts.oauth2` object; add a readiness helper for it if the poll needs it.
- `packages/drive-sync/src/testing/gisFake.ts` — add `initCodeClient` stub +
  `queueCodeResponse` / `queueCodeError`; install both stubs.
- `packages/drive-sync/src/testing/tokenExchangeFake.ts` — NEW. `createTokenExchangeFake()`.
- `packages/drive-sync/src/testing/index.ts` — export the new fake + its types.
- `packages/drive-sync/src/__tests__/envelope.test.ts` — NEW specs.
- `packages/drive-sync/src/__tests__/envelope-call-sites.test.ts` — NEW specs (routing).
- `packages/drive-sync/README.md` — new "Server-facilitated token exchange" section.
- `packages/drive-sync/SPEC.md` — §2 new decisions, §4 state-machine branch, §5 limits.
- `packages/drive-sync/package.json` — `version` `0.5.7` -> `0.6.0`.
- `apps/drive-sync-oauth-tester/vite.config.ts` — `server.proxy` `/callback` entry.
- `apps/drive-sync-oauth-tester/src/main.ts` — pass `tokenExchangeUrl` when env set.
- `apps/drive-sync-oauth-tester/.env.local.example` — add `VITE_DRIVE_TOKEN_EXCHANGE_URL`
  placeholder (default `/callback`), no secrets.
- `apps/drive-sync-oauth-tester/index.html` — optional: show envelope/guid in status panel.

## Tasks

Each task ≤30 min. Deps are task ids. Do every task inside the worktree from T0.

### T0 — Create git worktree
**Deps:** none
**Files:** none (git only)
**Do:** from `/home/mohan/owa/owa` run
`git worktree add ../worktree-drive-sync-server-token-auth -b drive-sync/server-token-auth`,
then `cd ../worktree-drive-sync-server-token-auth`. All later tasks happen here.
Run `pnpm install` (or the repo's package manager) if `node_modules` not linked.
**Test cases:** n/a
**Acceptance:** `git worktree list` shows the new worktree on branch
`drive-sync/server-token-auth`; cwd is the worktree; `pnpm -C packages/drive-sync test`
runs (all green, baseline).

### T1 — Add Envelope types + `tokenExchangeUrl` option
**Deps:** T0
**Files:** `packages/drive-sync/src/types.ts`, `packages/drive-sync/src/index.ts`
**Do:**
- In `types.ts` add `tokenExchangeUrl?: string` to `DriveSyncOptions` (JSDoc: opt-in;
  absent = legacy implicit flow unchanged).
- Add `EnvelopePayload { access_token: string; expiry_date: number; token_type:
  'Bearer'; scope: string }` and `Envelope { v: 2; guid: string; payload:
  EnvelopePayload; sig: string }`. JSDoc: opaque, `sig` never verified client-side.
- In `index.ts` add `Envelope`, `EnvelopePayload` to the existing `export type { ... }
  from './types.js'` line.
**Test cases:**
- happy: `pnpm -C packages/drive-sync build` (tsc) passes.
- edge: importing `{ Envelope }` from package root type-checks in a scratch `.ts`.
- error: giving `tokenExchangeUrl` a non-string in a scratch file is a tsc error.
**Acceptance:** tsc clean; new types exported from root; no runtime code changed;
existing tests still green.

### T2 — Storage helpers for the `envelope` key
**Deps:** T1
**Files:** `packages/drive-sync/src/storage.ts`
**Do:**
- Add `const ENVELOPE_KEY = 'envelope'`.
- Widen `AuthDbSchema.auth.value` union to also include `Envelope` (import type).
- Add `getEnvelope(appId, projectId): Promise<Envelope | undefined>`,
  `setEnvelope(appId, projectId, env: Envelope)`, `clearEnvelope(appId, projectId)`
  — copy the exact shape of `getToken/setToken/clearToken`.
- Do NOT touch `openAuthDb` version (stays `1`). No `upgrade` change.
**Test cases:**
- happy: unit — `setEnvelope` then `getEnvelope` round-trips the exact object
  (deep-equal, incl. `sig`).
- edge: `getEnvelope` on a project that never stored one returns `undefined`.
- error: `clearEnvelope` on an empty store does not throw; subsequent `getEnvelope`
  is `undefined`.
**Acceptance:** DB still opens at version 1; `token`/`conn` helpers untouched;
new helpers covered by a spec in `storage`-adjacent test (or the new envelope spec).

### T3 — `envelope.ts`: server HTTP calls + error mapping + retry
**Deps:** T1
**Files:** `packages/drive-sync/src/envelope.ts` (new), `packages/drive-sync/src/errors.ts`
(only if a new `NeedsReauthError` reason string needs documenting — no new class)
**Do:**
- `deriveToken(payload: EnvelopePayload): StoredToken` — `accessToken =
  payload.access_token`, `expiresAt = payload.expiry_date`, `grantedScopes =
  payload.scope.split(' ').filter(Boolean)`.
- `async function postExchange(url, body: { code: string } | { envelope: Envelope },
  logger?): Promise<Envelope>` — plain global `fetch`, `method: 'POST'`,
  `headers: { 'Content-Type': 'application/json' }`, `body: JSON.stringify(body)`,
  no credentials. On `res.ok` parse `{ envelope }` and return it.
- Error mapping (throws typed `NeedsReauthError`):
  - `410` (`code === 'refresh_token_revoked'`, or bare 410) -> throw a sentinel the
    caller maps to "clear conn+token+envelope" + `NeedsReauthError({ reason:
    'refresh_token_revoked' })`.
  - `502` / network throw / non-JSON body -> retryable.
  - `400`/`401`/`404` -> `logger?.error(...)` then `NeedsReauthError({ reason:
    'exchange_failed' })`, no retry.
- `async function postExchangeWithRetry(...)` — wrap `postExchange`: on retryable,
  wait 500ms, retry; on retryable again, wait 1500ms, retry; then throw
  `NeedsReauthError({ reason: 'exchange_unavailable' })`. Use real `setTimeout`
  (works under fake timers like `gis.ts` note).
- Keep clearing OUT of this module where the caller owns storage lifecycle — but it
  MAY import `clearConn/clearToken/clearEnvelope` for the `410` case (decision 7
  says `refreshEnvelope` itself clears on 410). Put the 410 clear inside
  `refreshEnvelope` (T4) and the connect-exchange caller (T6); `postExchange` just
  throws a distinguishable error.
**Test cases:**
- happy: fake `fetch` returns `200 { envelope }` -> `postExchange` resolves that
  envelope object unchanged.
- edge: first call throws `TypeError` (network), second returns 200 ->
  `postExchangeWithRetry` resolves after one 500ms wait.
- edge: `502` then `502` then `200` -> resolves after 500ms + 1500ms waits.
- error: `502` x3 -> rejects `NeedsReauthError` reason `exchange_unavailable`.
- error: `400 { error: { code: 'malformed_request' } }` -> rejects
  `NeedsReauthError` reason `exchange_failed`, no retry, `logger.error` called once.
- error: `410 { error: { code: 'refresh_token_revoked' } }` -> rejects with the
  distinguishable 410 error (reason `refresh_token_revoked`), no retry.
**Acceptance:** module has no import of `driveFetch`; all branches unit-covered with a
stubbed `globalThis.fetch`; retry delays asserted via fake timers.

### T4 — `refreshEnvelope` internal (freshness, coalescing, broadcast)
**Deps:** T2, T3
**Files:** `packages/drive-sync/src/envelope.ts`, `packages/drive-sync/src/token.ts`
**Do:**
- In `token.ts`: add `notifyExternalEnvelopeRefresh(projectId)` + a private
  `externallyRefreshedEnvelope` Set mirroring `externallyRefreshed`, OR extend the
  existing `externallyRefreshed` Set to also gate the envelope read. Pick the
  parallel-set approach (cleaner, no cross-talk with the legacy path); export it.
- In `envelope.ts` add:
  `export async function refreshEnvelope(opts: { appId; projectId; tokenExchangeUrl;
  logger? }): Promise<StoredToken>`:
  1. If a cross-tab envelope signal for this `projectId` is pending, drain it and
     re-read stored envelope first.
  2. Read stored envelope. If none -> `throw new NeedsReauthError({ reason:
     'exchange_failed' })` (no envelope == not connected in this mode).
  3. Freshness: if `Date.now() < envelope.payload.expiry_date - REFRESH_BUFFER_MS`
     (import the 5-min buffer; keep one source — re-export from `refresh.ts` or a
     shared const module) -> return `deriveToken(envelope.payload)`, NO network.
  4. Else `postExchangeWithRetry(tokenExchangeUrl, { envelope }, logger)`.
     - On `410` sentinel: `clearConn` + `clearToken` + `clearEnvelope`, then
       `throw NeedsReauthError({ reason: 'refresh_token_revoked' })`.
     - On success: `setEnvelope(new)`, `setToken(deriveToken(new.payload))`,
       `createBroadcast(appId).postToken(projectId)`, return the derived token.
  5. Coalesce concurrent calls per `projectId` with a module `Map<string,
     Promise<StoredToken>>` cleared in `finally` — same pattern as `token.ts`
     `inFlight`.
**Test cases:**
- happy (fresh echo): stored envelope expiry 30 min out -> returns derived token,
  fake `fetch` NOT called, no broadcast.
- happy (stale refresh): stored envelope expiry 2 min out -> POSTs `{ envelope }`,
  persists returned envelope + derived token, `postToken` broadcast fired once.
- edge (coalescing): two concurrent `refreshEnvelope` same `projectId` while stale ->
  exactly one `fetch`; both resolve to the same token.
- edge (cross-tab): `notifyExternalEnvelopeRefresh(projectId)` called, storage now
  holds a fresh envelope -> next `refreshEnvelope` returns from storage, no `fetch`.
- error (no envelope): storage empty -> `NeedsReauthError` reason `exchange_failed`,
  no `fetch`.
- error (410): fake returns 410 -> conn+token+envelope all cleared,
  `NeedsReauthError` reason `refresh_token_revoked`.
**Acceptance:** deterministic under fake timers + `fake-indexeddb`; coalescing map
always drained; buffer constant has ONE definition.

### T5 — `connect()` envelope-mode branch
**Deps:** T3
**Files:** `packages/drive-sync/src/connection.ts`, `packages/drive-sync/src/gis.ts`
**Do:**
- `ConnectOptions` gains `tokenExchangeUrl?: string`.
- In `gis.ts`: add `isCodeClientAvailable()` / a `waitForGisCodeClient` (or a param
  on the existing wait) that polls for `google.accounts.oauth2.initCodeClient`.
  Confirm it lives on the same object (it does in real GIS). Keep the legacy
  `initTokenClient` poll for the legacy path untouched.
- New `acquireAuthCode({ clientId, scopes, hint?, logger? }): Promise<string>` — call
  `initCodeClient({ client_id, scope: scopes.join(' '), ux_mode: 'popup', hint,
  callback })`, then `requestCode()`. Resolve with `response.code`; reject
  `NeedsReauthError` on `response.error` / `error_callback` / a hard timeout
  (reuse `INTERACTIVE_REQUEST_TIMEOUT_MS`-style ceiling — put a local const).
  No `redirect_uri`, no `state`.
- In `connect`: if `opts.tokenExchangeUrl` set, take the envelope branch:
  1. `existing = await getConn(...)` (for `hint` only).
  2. `code = await acquireAuthCode({ clientId, scopes, hint: existing?.email, logger })`.
  3. `envelope = await postExchange(opts.tokenExchangeUrl, { code }, logger)` — on
     `410`/`400`/`401`/`404` map exactly like T3; on network/502 use
     `postExchangeWithRetry`.
  4. `setEnvelope(envelope)`; `token = deriveToken(envelope.payload)`;
     `setToken(token)`.
  5. `email = await opts.fetchEmail(token.accessToken)` (once; NO wrong-account
     compare).
  6. `setConn({ email, grantedScopes: token.grantedScopes, connectedAt: Date.now() })`.
  7. return `{ email, needsReauth: false, expiresAt: token.expiresAt }`.
- Legacy branch (no `tokenExchangeUrl`) unchanged byte-for-byte.
**Test cases:**
- happy: `tokenExchangeUrl` set, GIS fake yields `{ code: 'abc' }`, exchange fake
  mints envelope -> `envelope`+`token`+`conn` all persisted; `fetchEmail` called once
  with `payload.access_token`; returns `needsReauth: false`.
- edge: `connect()` called twice -> second run does a fresh code flow, new `guid`,
  `setEnvelope` overwrites (no short-circuit on existing conn).
- error: exchange fake returns `400` -> `connect` rejects `NeedsReauthError` reason
  `exchange_failed`; nothing persisted.
- error (legacy): `tokenExchangeUrl` absent -> identical calls/asserts to today's
  `connection.test.ts` connect happy path (copy an existing assertion).
**Acceptance:** legacy `connection.test.ts` unmodified and green; envelope path never
calls `acquireToken`/`initTokenClient`.

### T6 — `getAccessToken()` envelope-mode branch
**Deps:** T4
**Files:** `packages/drive-sync/src/connection.ts`
**Do:**
- `GetAccessTokenOptions` gains `tokenExchangeUrl?: string`.
- In `getAccessToken`: if `opts.tokenExchangeUrl` set:
  1. `cached = await getToken(...)`; if `cached.expiresAt > Date.now() +
     TOKEN_REUSE_BUFFER_MS` return `cached.accessToken` (unchanged reuse check).
  2. Else `token = await refreshEnvelope({ appId, projectId, tokenExchangeUrl,
     logger })`; return `token.accessToken`.
  3. NEVER call `acquireToken` / interactive code flow on this path (Picker needs an
     already-connected project; a missing envelope surfaces as `NeedsReauthError`
     from `refreshEnvelope`).
- Legacy branch unchanged.
**Test cases:**
- happy (fresh cache): valid cached token -> returned as-is, no `fetch`.
- happy (stale): cached token near expiry, stored envelope stale -> `refreshEnvelope`
  round-trips, returns new `payload.access_token`.
- error (not connected): no envelope, no token -> `NeedsReauthError`, no popup.
- error (legacy path unaffected): `tokenExchangeUrl` absent -> existing
  `getAccessToken` behavior (assert `acquireToken` still invoked).
**Acceptance:** Picker path never triggers `initCodeClient`; legacy picker tests green.

### T7 — `disconnect()` envelope-mode branch
**Deps:** T2
**Files:** `packages/drive-sync/src/connection.ts`
**Do:**
- `DisconnectOptions` gains `tokenExchangeUrl?: string`.
- In `disconnect`: keep reading `token` and calling `opts.revokeFn(token.accessToken)`
  best-effort (unchanged). Then:
  - always `clearConn` + `clearToken` (unchanged),
  - additionally `await clearEnvelope(appId, projectId)` — safe/no-op when the key
    was never written, so it can run unconditionally regardless of
    `tokenExchangeUrl`. (Simplest + matches decision 4 "disconnect clears
    conn+token+envelope".)
  - `createBroadcast(appId).postLogout(projectId)` unchanged.
- Revoke network failure still swallowed by the `index.ts` `revokeFn` wrapper — do
  not change that.
**Test cases:**
- happy (envelope mode): envelope + token present -> `revokeFn` called with
  `payload.access_token`; conn+token+envelope all cleared; `postLogout` fired.
- edge: `revokeFn` rejects -> `disconnect` still resolves; all three keys cleared.
- edge (legacy): no envelope key ever written -> `clearEnvelope` no-op, existing
  `disconnect` test assertions unchanged.
- error: no token cached -> `revokeFn` NOT called (unchanged guard); keys cleared.
**Acceptance:** existing `disconnect` tests green; envelope key gone after disconnect.

### T8 — `http.ts` 401 retry via `refreshEnvelope`
**Deps:** T4
**Files:** `packages/drive-sync/src/http.ts`
**Do:**
- `DriveFetchOptions` gains `tokenExchangeUrl?: string`.
- Cached-token fast path (top of `driveFetch`) unchanged.
- Token acquisition (the `acquireToken` call in `driveFetch`): if
  `opts.tokenExchangeUrl` set and not interactive -> `token = await refreshEnvelope(
  { appId, projectId, tokenExchangeUrl, logger })` instead of `acquireToken`.
  Interactive + envelope mode with no usable token -> `NeedsReauthError` (Drive calls
  never drive the interactive code popup; only `connect()` does).
- 401 handling in `performFetch`: when `opts.tokenExchangeUrl` set:
  - `isRetryAfter401 || interactive` -> `NeedsReauthError` (unchanged).
  - else `await clearToken(appId, projectId)` (token key ONLY, per decision 4/8);
    `refreshed = await refreshEnvelope({...})`; `return performFetch(opts,
    refreshed.accessToken, /* isRetryAfter401 */ true)`.
  - A `refreshEnvelope` throw (incl. `410` which also clears conn+envelope) ->
    propagate as-is (it is already `NeedsReauthError`).
- Legacy branch (`refreshSilently` / `acquireToken` fallback) unchanged when
  `tokenExchangeUrl` absent.
**Test cases:**
- happy: envelope mode, Drive returns 401 once then 200 -> `token` cleared,
  `refreshEnvelope` called, original request retried once, success returned.
- edge: 401 then 401 -> `NeedsReauthError`, `refreshEnvelope` called exactly once.
- edge: envelope mode, `refreshEnvelope` throws `410` -> conn+token+envelope cleared,
  `NeedsReauthError` reason `refresh_token_revoked` propagates.
- error (legacy): `tokenExchangeUrl` absent, 401 path -> identical to existing
  `http`/`regressions` 401 tests (unchanged).
**Acceptance:** existing 401 retry tests green; envelope 401 path never calls
`acquireToken`.

### T9 — `refresh.ts` warm-up + `index.ts` `activate()` wiring
**Deps:** T4
**Files:** `packages/drive-sync/src/refresh.ts`, `packages/drive-sync/src/index.ts`
**Do:**
- `refresh.ts` `ActivateOptions` gains `tokenExchangeUrl?: string`.
- `warmUpIfNeeded`: same gate (conn exists; token missing or within
  `REFRESH_BUFFER_MS` of expiry; never when `document.hidden`). If
  `opts.tokenExchangeUrl` set -> `await refreshEnvelope({ appId, projectId,
  tokenExchangeUrl, logger })` (wrapped in the existing try/catch that only
  `logger.warn`s). Else legacy `refreshSilently` / `acquireToken` fallback unchanged.
- `index.ts`:
  - `const { appId, clientId, folderPath, tokenExchangeUrl } = options;`
  - `runWarmUps()` passes `tokenExchangeUrl` into `warmUpIfNeeded`.
  - `connect()` facade -> pass `tokenExchangeUrl` to `connectImpl`.
  - `disconnect()` facade -> pass `tokenExchangeUrl` to `disconnectImpl` (or rely on
    unconditional `clearEnvelope` from T7 — still pass it for symmetry/future).
  - `getAccessToken` + `pickFile`'s `getAccessTokenImpl` calls -> pass
    `tokenExchangeUrl`.
  - `files`/`permissions` `base` object -> add `tokenExchangeUrl` so `driveFetch`
    gets it through `filesImpl`/`permissionsImpl` (check those forward `...base` into
    `driveFetch` opts; thread the field if a whitelist exists).
**Test cases:**
- happy: envelope mode, conn present, token stale, tab visible -> `activate()` +
  dispatch `visibilitychange` -> `refreshEnvelope` runs, token refreshed.
- edge: `document.hidden` -> `visibilitychange` handler does NOT call
  `refreshEnvelope`.
- edge: `refreshEnvelope` throws -> `warmUpIfNeeded` swallows, only `logger.warn`.
- edge (legacy): `tokenExchangeUrl` absent -> `refreshSilently`/`acquireToken` path,
  existing `refresh.test.ts` unchanged.
**Acceptance:** all three legacy silent-refresh call sites now have the
`tokenExchangeUrl` branch; `refresh.test.ts` green unmodified; `files`/`permissions`
calls carry `tokenExchangeUrl` into `driveFetch`.

### T10 — Extend `createGisFake` with `initCodeClient`
**Deps:** T0
**Files:** `packages/drive-sync/src/testing/gisFake.ts`
**Do:**
- Add `queueCodeResponse(res: { code?: string; error?: string })` +
  `queueCodeError(type: string)` + a `codeCalls: { scope: string; hint?: string }[]`
  record array.
- Implement `initCodeClient(config)` returning `{ requestCode() { ... } }` that:
  records the call, then (microtask) fires `config.callback({ code })` or, on a
  queued error, `config.error_callback({ type })` / `config.callback({ error })`.
  Mirror the async delivery + `queueSilence` support already in the token stub.
- `install()` also sets `w.google.accounts.oauth2.initCodeClient = initCodeClient`.
  Legacy `initTokenClient` stub untouched, so implicit-path tests are unaffected.
- `reset()` clears the new queues + `codeCalls`.
- Update the new fake's exported types.
**Test cases:**
- happy: `queueCodeResponse({ code: 'xyz' })` -> code client `requestCode()` fires
  callback with `{ code: 'xyz' }`; `codeCalls[0].scope` is the joined REQUIRED_SCOPES.
- edge: no queued response -> a sensible default `{ code: 'fake-auth-code' }`.
- edge: `queueCodeError('popup_closed')` -> `error_callback` invoked, `callback` not.
- error: implicit-path test file that only uses `initTokenClient` still passes
  unchanged (run `gis.test.ts` / `token-*.test.ts`).
**Acceptance:** `install()` exposes BOTH clients; `createGisFake` back-compatible;
`testing-exports.test.ts` still green (extend it if it snapshots exports).

### T11 — `createTokenExchangeFake()`
**Deps:** T1
**Files:** `packages/drive-sync/src/testing/tokenExchangeFake.ts` (new),
`packages/drive-sync/src/testing/index.ts`
**Do:**
- `createTokenExchangeFake(opts?: { secret?: string; now?: () => number })` returns:
  - `install()` / `uninstall()` — swap `globalThis.fetch` with a handler that only
    intercepts requests whose URL matches the configured `tokenExchangeUrl`
    (default `https://open-webapp.duckdns.org/callback` AND `/callback`); everything
    else falls through to the real/previous `fetch`.
  - Envelope minting: `payload` -> canonical JSON (keys sorted, no whitespace) of
    `{ v, guid, payload }` -> HMAC-SHA256 with the test secret -> base64url = `sig`.
    Use Web Crypto (`crypto.subtle`) available in the vitest/node env.
  - Request handling:
    - body `{ code }` -> new `guid` (uuidv4), fresh `payload` (expiry `now +
      3600_000`), return `200 { envelope }`.
    - body `{ envelope }` -> if `now() < payload.expiry_date - 60000` echo the SAME
      envelope; else mint a new `payload` (same `guid`), new `sig`, return it.
    - both / neither -> `400 { error: { code: 'code_and_envelope_exclusive' |
      'code_or_envelope_required' } }`.
  - On-demand overrides: `fail410()`, `fail502(times?)`, `failMalformed()`,
    `failInvalidSig()`, `failUnknownGuid()` — each affects the next N calls.
  - Accessors: `calls: Array<{ kind: 'code' | 'envelope'; body: unknown }>`;
    `lastEnvelope`; `setExpiry(msFromNow)` to force staleness.
- Export `createTokenExchangeFake` + types from `testing/index.ts`.
**Test cases:**
- happy: `{ code }` -> `200`, envelope has `v: 2`, uuid `guid`, `payload.token_type
  === 'Bearer'`, `sig` non-empty; `calls[0].kind === 'code'`.
- happy: replay a fresh envelope -> byte-identical echo (deep-equal).
- edge: replay a stale envelope (`setExpiry(-1000)`) -> new `payload`, SAME `guid`,
  different `access_token`.
- edge: `fail502(2)` then normal -> two `502 { error: { code: 'google_unavailable' } }`
  then a `200`.
- error: `fail410()` -> `410 { error: { code: 'refresh_token_revoked' } }`.
- error: POST to an unrelated URL -> fake does not intercept (falls through).
**Acceptance:** exported from `./testing`; deterministic with injected `now`;
`uninstall()` fully restores `globalThis.fetch`.

### T12 — Vitest specs: envelope core paths
**Deps:** T4, T5, T6, T7, T10, T11
**Files:** `packages/drive-sync/src/__tests__/envelope.test.ts` (new)
**Do:** using `createGisFake` + `createTokenExchangeFake` + `fake-indexeddb`:
- connect code->envelope happy path: envelope+token+conn persisted, `fetchEmail`
  called once.
- `refreshEnvelope` fresh-echo (no `fetch`) vs stale-refresh (POST, persist,
  broadcast).
- `410` clears all three keys + throws `NeedsReauthError` reason
  `refresh_token_revoked`.
- `502` retries at 500ms + 1500ms (fake timers) then throws reason
  `exchange_unavailable`.
- `disconnect` revokes `payload.access_token` and clears all three keys.
- per-`projectId` coalescing: 2 concurrent stale refreshes -> 1 POST.
- legacy path unaffected: same-file test with NO `tokenExchangeUrl` still uses
  `initTokenClient` and never hits the exchange fake.
**Test cases:** (the bullets above are the cases — each an `it(...)`)
- happy: listed.
- edge: coalescing, fresh-echo, cross-tab storage-first.
- error: 410, 502-exhausted, connect-time 400.
**Acceptance:** file green; no reliance on real network/timers; run in isolation and
in the full `vitest run`.

### T13 — Vitest specs: call-site routing
**Deps:** T6, T8, T9, T10, T11
**Files:** `packages/drive-sync/src/__tests__/envelope-call-sites.test.ts` (new)
**Do:** assert each of the THREE legacy silent-refresh call sites routes by
`tokenExchangeUrl`:
- `http.ts` 401 retry -> `refreshEnvelope` when set; `refreshSilently`/`acquireToken`
  when unset.
- `refresh.ts` `warmUpIfNeeded` -> `refreshEnvelope` when set; legacy when unset.
- `index.ts` `activate()` visibility handler -> triggers the envelope warm-up when
  set; never when `document.hidden`.
- `getAccessToken` (Picker path) -> `refreshEnvelope` when set, never `initCodeClient`.
**Test cases:**
- happy: set -> exchange fake sees the replay; GIS token stub sees nothing.
- edge: unset -> GIS token stub sees the call; exchange fake sees nothing.
- edge: `document.hidden` -> neither.
- error: envelope missing in envelope mode -> `NeedsReauthError` from each call site.
**Acceptance:** file green; explicit assertion that the OTHER path's fake was not
called (spy `calls.length === 0`).

### T14 — Confirm `gis.ts` code-client readiness
**Deps:** T5
**Files:** `packages/drive-sync/src/gis.ts`, `packages/drive-sync/src/__tests__/gis.test.ts`
**Do:**
- If T5 added an `initCodeClient` poll, add a `gis.test.ts` case: fake sets only
  `initTokenClient` -> code-client wait rejects `GisLoadError` after timeout; fake
  sets `initCodeClient` -> resolves. If T5 reused the existing `initTokenClient`
  poll (real GIS ships both together), document that assumption in a code comment
  and add a case asserting the code path still works when only `initCodeClient` is
  present.
- No behavior change to the legacy `waitForGoogleIdentityServices` for the implicit
  path.
**Test cases:**
- happy: `initCodeClient` present -> readiness resolves.
- edge: neither present -> `GisLoadError` after 10s (fake timers).
- error: legacy `waitForGoogleIdentityServices` unchanged — existing `gis.test.ts`
  cases green.
**Acceptance:** readiness for the code client is explicit and tested; legacy poll
untouched.

### T15 — Tester app: env + Origin-spoof proxy + wiring
**Deps:** T1, T9
**Files:** `apps/drive-sync-oauth-tester/vite.config.ts`,
`apps/drive-sync-oauth-tester/src/main.ts`,
`apps/drive-sync-oauth-tester/.env.local.example`,
`apps/drive-sync-oauth-tester/index.html` (optional status field)
**Do:**
- `vite.config.ts`:
  ```
  export default defineConfig({
    server: {
      proxy: {
        '/callback': {
          target: 'https://open-webapp.duckdns.org',
          changeOrigin: true,
          headers: { Origin: 'https://open-webapp.github.io' },
        },
      },
    },
  });
  ```
- `.env.local.example`: add `VITE_DRIVE_TOKEN_EXCHANGE_URL=/callback` (placeholder,
  no secret). Comment: unset -> legacy GIS implicit flow.
- `main.ts`: read `import.meta.env.VITE_DRIVE_TOKEN_EXCHANGE_URL`; pass
  `tokenExchangeUrl: <that>` into `createDriveSync` ONLY when truthy. Existing
  buttons unchanged.
- `index.html` (optional): add a `<span id="guid">` line; `renderStatus` shows the
  stored envelope `guid` when present (read via a tiny debug helper or
  `p.getConnection()` unaffected — guid display is best-effort, may be skipped if it
  needs new public API; do NOT add public API for it).
**Test cases:**
- happy: `pnpm -C apps/drive-sync-oauth-tester build` (or `vite build`) passes with
  and without the env var set.
- edge: env unset -> `createDriveSync` called with no `tokenExchangeUrl`; connect
  button still runs the implicit flow.
- error: `tsc`/vite type-check clean.
**Acceptance:** dev server proxies `/callback` to the duckdns host with a spoofed
allowed `Origin`; no secrets added to `.env.local.example`.

### T16 — Tester app: manual verification checklist (run + record)
**Deps:** T15
**Files:** `plans/drive-sync-oauth-tester.md` (append a checklist section only)
**Do:** with a real `VITE_DRIVE_CLIENT_ID` matching the server's `GOOGLE_CLIENT_ID`
and `VITE_DRIVE_TOKEN_EXCHANGE_URL=/callback`, run `vite` dev and walk:
1. Click connect -> Google code popup -> completes -> IndexedDB `auth` store has an
   `envelope` key (v2, uuid guid) + a derived `token` key + a `conn` key.
2. Force-expire: in devtools set the stored envelope `payload.expiry_date` to
   `Date.now() - 1000`; trigger a Drive call / tab re-focus -> `refreshEnvelope`
   POSTs `{ envelope }` -> new access token, new `token.expiresAt`, envelope
   replaced.
3. Click disconnect -> Network shows a Google `revoke` POST with the access token;
   `conn` + `token` + `envelope` all gone from IndexedDB.
4. Simulate `410`: temporarily point the proxy at a stub returning
   `410 { error: { code: 'refresh_token_revoked' } }` (or use a server test guid) ->
   next refresh clears all three keys + surfaces a re-consent prompt / `NeedsReauthError`.
**Test cases:** manual — each numbered step is a pass/fail line in the checklist.
**Acceptance:** checklist appended to `plans/drive-sync-oauth-tester.md` with observed
results filled in; all four steps pass (or deviations recorded as follow-ups).

### T17 — Docs: SPEC.md + README.md + version bump
**Deps:** T1–T14 (feature code + tests complete and green)
**Files:** `packages/drive-sync/SPEC.md`, `packages/drive-sync/README.md`,
`packages/drive-sync/package.json`
**Do:**
- `package.json`: `"version": "0.5.7"` -> `"0.6.0"`.
- `README.md`: new "Server-facilitated token exchange" section — what
  `tokenExchangeUrl` does, the code->envelope->replay model, that `refresh_token`
  stays server-side, opt-in / legacy-unchanged, CORS note (github.io origins; tester
  needs the Origin-spoof proxy).
- `SPEC.md`:
  - §2: add the new resolved-decision entries for envelope mode (summarize decisions
    1–18 into the spec's numbered style).
  - §3 Storage layout: add the `envelope` key to the `auth` store description.
  - §4 Refresh state machine: add the envelope branch (freshness check ->
    echo-or-replay -> persist+broadcast; `410` -> clear all three -> reauth).
  - §5 Known limitations: (a) orphaned server `<guid>/perm-token.json` never cleaned
    up (no revoke endpoint; disconnect only kills the grant via access-token
    revoke); (b) Google returns `refresh_token` only on first consent per
    user+client and `initCodeClient` has no `prompt` knob, so a re-`connect()` new
    `guid` may be un-refreshable server-side; (c) tester needs the Origin-spoof
    proxy because the server CORS allowlist is github.io-only and credentials are
    disabled; (d) server `GOOGLE_REDIRECT_URI` assumed `postmessage` for popup-mode
    code exchange — not verified.
**Test cases:**
- happy: `pnpm -C packages/drive-sync build` still passes; `grep 0.6.0 package.json`.
- edge: markdown lint / links resolve (`callback-api.md` URL correct).
- error: no code snippet in README references removed/renamed symbols.
**Acceptance:** SPEC + README describe envelope mode accurately; version is `0.6.0`.

### T18 — Full test + lint gate
**Deps:** T12, T13, T14, T15, T17
**Files:** none (CI-style run)
**Do:** from the worktree run the repo's full check for the package:
`pnpm -C packages/drive-sync test` and `pnpm -C packages/drive-sync build`, plus any
workspace lint (`pnpm lint` if defined). Fix any fallout.
**Test cases:**
- happy: `vitest run` all green (old + new specs).
- edge: run `vitest run` twice / randomized order -> still green (no test cross-talk
  via `globalThis.fetch` or GIS stubs).
- error: `tsc` build emits no errors; `dist` types include `Envelope`.
**Acceptance:** clean `test` + `build`; no `.only`, no skipped envelope specs.

### T19 — Commit + push branch
**Deps:** T18
**Files:** none (git only)
**Do:** stage all changed files; commit with a descriptive message
(`feat(drive-sync): opt-in server-facilitated OAuth token exchange (envelope mode)`);
end the message with the required
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` +
`Claude-Session: https://claude.ai/code/session_01BTe4ECSG43mdTKuTYxx4SC` trailers.
Push `drive-sync/server-token-auth`. Open a PR (body ends with the required
"Generated with Claude Code" line).
**Test cases:** n/a
**Acceptance:** commit exists on the branch; `git status` clean; branch pushed; PR open.

### T20 — Release tag (post-merge)
**Deps:** T19 + the PR merged to `main`
**Files:** none (git only)
**Do:** AFTER the PR merges to `main`, from `main`:
`git tag drive-sync-v0.6.0 && git push origin drive-sync-v0.6.0` (version read from
`packages/drive-sync/package.json`, per repo `CLAUDE.md`). This triggers the publish
workflow.
**Test cases:** n/a
**Acceptance:** tag `drive-sync-v0.6.0` exists on the merge commit and is pushed;
publish workflow starts.

### T21 — Cleanup git worktree
**Deps:** T19 (T20 does not block this — teardown only needs the branch pushed)
**Files:** none (git only)
**Do:** `cd /home/mohan/owa/owa`; `git worktree remove
../worktree-drive-sync-server-token-auth` (add `--force` only if it complains about
the still-open shell). Confirm the branch and its commit survive the worktree removal.
**Test cases:** n/a
**Acceptance:** `git worktree list` no longer shows the worktree; original directory
active; `drive-sync/server-token-auth` branch still exists with the commit; (once
merged) T20's tag is independent of this cleanup.

## Test strategy
- **Unit (vitest + `fake-indexeddb`)**: every new function in `envelope.ts`
  (`deriveToken`, `postExchange`, `postExchangeWithRetry`, `refreshEnvelope`) covered
  for happy + retry + each error `code`. `storage.ts` envelope helpers round-tripped.
- **Integration-ish (still vitest)**: `connect`/`getAccessToken`/`disconnect`/`http`
  401/`warmUpIfNeeded`/`activate()` each exercised in BOTH modes via
  `createGisFake` (both clients) + `createTokenExchangeFake` (installable `fetch`).
  Explicit "other path's fake never called" assertions guard the opt-in gate.
- **Regression**: the entire existing `src/__tests__` suite must pass UNMODIFIED
  (decision 1). Any diff to a legacy spec is a bug in the plan's execution.
- **Timers**: retry backoff (500ms / 1500ms) and GIS timeouts asserted with
  `vi.useFakeTimers()`; envelope HTTP uses real `setTimeout` like `gis.ts`.
- **Manual**: T16 checklist against the live `/callback` endpoint through the
  Origin-spoof Vite proxy.
- **Build**: `tsc` must emit `Envelope`/`EnvelopePayload` in `dist/index.d.ts`.

## Risks
- **Server `GOOGLE_REDIRECT_URI` must be `postmessage`** for popup-mode code
  exchange. Assumed, not verified. Mitigation: T16 step 1 fails loudly if the code
  exchange 4xxs; record the server response `code` and stop — do not ship.
- **`refresh_token` only on first consent per user+client**; `initCodeClient` has no
  `prompt: 'consent'` knob, so a re-`connect()` producing a new `guid` whose Google
  response omits `refresh_token` yields an un-refreshable server grant. Mitigation:
  documented in SPEC §5; assumed handled server-side; T16 step 4 exercises the
  `410` recovery UX so the client at least degrades to a clean re-consent.
- **Tester cannot hit `/callback` from localhost** without the Origin-spoof proxy
  (CORS allowlist is github.io-only, credentials disabled). Mitigation: T15 adds the
  proxy; `.env.local.example` defaults `VITE_DRIVE_TOKEN_EXCHANGE_URL=/callback`.
- **Orphaned `<guid>/perm-token.json` accumulate server-side** (no revoke endpoint;
  disconnect only kills the grant via access-token revoke). Mitigation: SPEC §5
  limitation; out of scope to fix here.
- **`initCodeClient` presence on `google.accounts.oauth2`**: `gis.ts` currently
  polls only for `initTokenClient`. Mitigation: T5/T14 add + test an explicit
  readiness check for `initCodeClient`.
- **`globalThis.fetch` stub leakage across tests** (envelope fake + real
  `fetchEmail`/`revokeToken` both use global `fetch`). Mitigation:
  `createTokenExchangeFake` intercepts ONLY the exchange URL and delegates the rest;
  `uninstall()` in `afterEach`; T18 randomized-order run.
- **Two cross-tab signal sets** (`externallyRefreshed` vs new
  `externallyRefreshedEnvelope`) could drift. Mitigation: mirror the existing
  pattern exactly; unit test the cross-tab storage-first case (T4).
- **`REFRESH_BUFFER_MS` duplicated** (already exists in `refresh.ts`,
  `connection.ts`, `http.ts` as `TOKEN_REUSE_BUFFER_MS`). Mitigation: `envelope.ts`
  imports one existing constant rather than adding a fourth copy; note it in the PR.

## Open questions
- Does the deployed server actually use `GOOGLE_REDIRECT_URI=postmessage`? If it
  expects a real redirect URI, popup `initCodeClient` code exchange will fail and
  T5/T16 need rework (possible fallback: `ux_mode: 'redirect'` — much larger change).
- Is `crypto.subtle` HMAC available in the project's vitest environment (node vs
  jsdom)? If not, `createTokenExchangeFake` needs a `node:crypto` fallback.
- Should the tester surface the envelope `guid` in its status panel? Doing so may
  need a new debug accessor on the public API — plan currently says NO (skip rather
  than expand the frozen API).
- Confirm `files.ts`/`permissions.ts` forward arbitrary `base` fields into
  `driveFetch` opts (so `tokenExchangeUrl` rides through) vs. an explicit field
  whitelist that must be widened.
- Package manager: repo has a deleted `package-lock.json` in git status but skills
  reference `pnpm` — confirm `pnpm` vs `npm` for the install/test/build commands in
  T0/T18.

## Post-change doc updates
- `packages/drive-sync/SPEC.md` — §2 (new decisions), §3 (`envelope` storage key),
  §4 (state-machine envelope branch), §5 (four new limitations). Done in T17.
- `packages/drive-sync/README.md` — new "Server-facilitated token exchange" usage
  section. Done in T17.
- `plans/drive-sync-oauth-tester.md` — append the manual checklist + results. Done in T16.
- `packages/drive-sync/package.json` — version `0.6.0`. Done in T17.
- Release: `git tag drive-sync-v0.6.0` + push, post-merge, per repo `CLAUDE.md`. T20.
- No `AGENTS.md` in this repo path; the root `CLAUDE.md` auto-tag rule is satisfied
  by T20.
