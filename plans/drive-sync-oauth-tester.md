# Plan: drive-sync OAuth manual tester app

## Goal
Build a tiny standalone app at `apps/drive-sync-oauth-tester/` whose only job is to click-test Google Drive OAuth connect/disconnect, plus a Google Picker manual test, against the real `@open-webapp/drive-sync` library. Three buttons (Connect, Disconnect, Pick File), a status readout (connected/disconnected, email, expiry), and a picked-files readout. No file ops, no folder reconciliation, no automated tests, no CI. Human clicks it and watches devtools + the UI to confirm the library's connect/disconnect/persist lifecycle and `pickFile()` actually work against real Google APIs.

## Scope
**In scope:**
- New workspace app `apps/drive-sync-oauth-tester/` (package.json, tsconfig.json, vite.config.ts, index.html, .env.local.example, src/main.ts)
- Root `.gitignore` update to ignore `.env.local`
- Manual (human-run) verification steps, documented as test cases per task and as an end-to-end checklist
- Google Picker manual test (`pickFile()`) — Pick File button + picked-files readout

**Out of scope:**
- Any change to `packages/drive-sync/**` or `packages/project-sync/**`, including docs — deliberately, to avoid touching a path CLAUDE.md's auto-tag/publish hook matches on. No README pointer is added there.
- Automated tests (no vitest, no CI workflow) for the new app
- File operations, folder reconciliation UI (`ensureFolderPath` is not called by this app)
- Any framework (React, etc.) — plain TS + DOM APIs only
- Root `package.json` workspace config changes (already covers `apps/*`)

## Resolved decisions
1. Location: `apps/drive-sync-oauth-tester/`. Root `apps/` currently has only `.gitkeep`; workspaces glob already covers it.
2. Stack: plain TypeScript + Vite (no UI framework). First real Vite bundler app in the repo — needs its own minimal `vite.config.ts`.
3. Depends on `@open-webapp/drive-sync` via `"workspace:*"`, imports only from package root `.` (not `./testing` fakes — this app talks to real Google APIs).
4. Not published to npm; lives under `apps/`, not `packages/`, so CLAUDE.md's auto-tag rule never fires as long as commits here never touch `packages/drive-sync/**` or `packages/project-sync/**`.
5. Config: only `clientId` from env via `import.meta.env.VITE_DRIVE_CLIENT_ID`, sourced from `.env.local` (gitignored, added this plan). `appId` and `folderPath` are hardcoded constants in source (`APP_ID = 'drive-sync-oauth-tester'`, `FOLDER_PATH = ['OAuthTester']`) since connect/disconnect never touch Picker or ensureFolderPath.
6. GIS script loaded via static `<script src="https://accounts.google.com/gsi/client" async defer>` in `index.html`, placed BEFORE the app's module script tag.
7. API surface exercised: `createDriveSync({appId, clientId, folderPath, logger})` → `activate()` once on load, `reconcile([PROJECT_ID])` once on load, `PROJECT_ID = 'oauth-tester'` hardcoded, `drive.project(PROJECT_ID)` → `getConnection()` on load to restore UI, Connect button → `p.connect()`, Disconnect button → `p.disconnect()`. `Connection = { email, needsReauth, expiresAt }`.
8. UI: exactly two buttons + status readout (connected/disconnected, email, human-readable expiry from `expiresAt` epoch ms or null). No JSON dump, no CSS framework, minimal inline styles OK.
9. Logger: object matching `Logger` interface (`debug/info/warn` → `console.debug/info/warn`, `error` → `console.error`), passed as `DriveSyncOptions.logger`.
10. No automated tests, no vitest, no CI files for this app.
11. Dev server: `vite`. Scripts: `dev`: `vite`, `build`: `vite build`, `preview`: `vite preview`. No `test` script (root uses `--if-present`, omitting is fine).
12. Vite version pinned to `^8.0.0` (current published latest is 8.2.2; no prior Vite usage elsewhere in the repo to mirror instead).
13. `disconnect()` (`packages/drive-sync/src/connection.ts`) is already idempotent: it unconditionally clears the durable connection + cached token regardless of whether either exists, and only calls `revokeFn` when a token is actually cached. No guard needed in the app's click handler.
14. No README pointer in `packages/drive-sync/README.md` — skipped. A docs-only edit there still matches CLAUDE.md's path-based auto-tag trigger (`packages/drive-sync`), and this app doesn't change the library's behavior, so there's nothing worth that risk for.
15. Picker config: two new env vars, `VITE_DRIVE_PICKER_API_KEY` and `VITE_DRIVE_PICKER_APP_ID` (GCP project number — distinct from `APP_ID`/`DriveSyncOptions.appId = 'drive-sync-oauth-tester'`, which is only for IndexedDB namespacing), both added to `.env.local.example`.
16. UI: new "Pick File" button (`pick-btn`), disabled by default, enabled only while connected — re-evaluated in `renderStatus` (or equivalent) alongside connect/disconnect state, not just once on load.
17. `pickFile()` call: `multiSelect: true`, no `mimeTypes` restriction (all file types), no `parentFolderId` (browses the whole Drive, not scoped to the app's own folder — `ensureFolderPath` is not called by this app).
18. On successful pick: render each result's `fileId`, `name`, `mimeType` in a new `#picked-files` list/container. `content` is not rendered (may be a large string or Blob).
19. On cancel (`PickerCancelledError` thrown): benign no-op — log at `info` level via the existing Logger, no error state shown, existing picked-files display left untouched.
20. No Picker JS API script tag in `index.html` — `ensurePickerLoaded()` in `picker.ts` lazy-loads `https://apis.google.com/js/api.js` internally, unlike the GIS script which the app loads manually.
21. On Disconnect: also clear the `#picked-files` display, for consistency with clearing connection status.

## Affected files
- `apps/drive-sync-oauth-tester/package.json` — new: app manifest, deps on `@open-webapp/drive-sync` (workspace:*), vite devDep, dev/build/preview scripts
- `apps/drive-sync-oauth-tester/tsconfig.json` — new: extends root base, overrides module/moduleResolution for Vite, adds vite/client types
- `apps/drive-sync-oauth-tester/vite.config.ts` — new: minimal/default Vite config
- `apps/drive-sync-oauth-tester/index.html` — new: entry HTML, GIS script tag + module script tag, two OAuth buttons + status containers, plus `pick-btn` button and `#picked-files` container
- `apps/drive-sync-oauth-tester/.env.local.example` — new: `VITE_DRIVE_CLIENT_ID=...` placeholder, plus `VITE_DRIVE_PICKER_API_KEY=...` and `VITE_DRIVE_PICKER_APP_ID=...` placeholders
- `apps/drive-sync-oauth-tester/src/main.ts` — new: logger, constants, createDriveSync setup, activate/reconcile/getConnection on load, button handlers, status rendering, plus pickFile() wiring, PickerCancelledError handling, and pick-btn enable/disable logic
- `/home/mohan/owa/owa/.gitignore` — add `.env.local` (or `.env*.local`) pattern

## Tasks

### T0 — Create git worktree
**Deps:** none
**Files:** none (git only)
**Do:** From `/home/mohan/owa/owa`, run `git worktree add ../worktree-drive-sync-oauth-tester -b drive-sync-oauth-tester/add-app`, then `cd ../worktree-drive-sync-oauth-tester`. All following tasks happen inside this worktree.
**Test cases:** n/a
**Acceptance:** worktree dir exists, branch `drive-sync-oauth-tester/add-app` checked out, cwd is the worktree.

### T1 — Scaffold app directory + package.json
**Deps:** T0
**Files:** `apps/drive-sync-oauth-tester/package.json`
**Do:** Create the dir. Write `package.json`:
```json
{
  "name": "@open-webapp/drive-sync-oauth-tester",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@open-webapp/drive-sync": "workspace:*"
  },
  "devDependencies": {
    "vite": "^8.0.0",
    "typescript": "^7.0.2"
  }
}
```
`typescript` version matches root `package.json`'s dependency (`^7.0.2`); `vite` pinned to `^8.0.0` (current published latest is 8.2.2 — this is the first Vite usage in the repo, so there's no existing convention to mirror instead).
**Test cases:**
- happy: `cat apps/drive-sync-oauth-tester/package.json` is valid JSON, `name` unique in workspace
- edge: `private: true` present so `npm publish` would refuse it even by accident
- error: no `publishConfig` field present (must not exist)
**Acceptance:** file exists, valid JSON, no `publishConfig` key, `private: true`.

### T2 — tsconfig.json
**Deps:** T1
**Files:** `apps/drive-sync-oauth-tester/tsconfig.json`
**Do:** Create extending root base but overriding for Vite:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src"]
}
```
**Test cases:**
- happy: `npx tsc --noEmit -p apps/drive-sync-oauth-tester/tsconfig.json` runs without "cannot find module" errors once src files exist (verify after T5)
- edge: confirms `import.meta.env.VITE_DRIVE_CLIENT_ID` type-checks (needs `vite/client` types)
- error: forgetting `moduleResolution: bundler` would break on `import.meta.env` resolution — verify override is present, not inherited NodeNext
**Acceptance:** file exists, extends base tsconfig, overrides module/moduleResolution to ESNext/bundler, includes vite/client types.

### T3 — vite.config.ts
**Deps:** T1
**Files:** `apps/drive-sync-oauth-tester/vite.config.ts`
**Do:** Minimal default config:
```ts
import { defineConfig } from 'vite';

export default defineConfig({});
```
**Test cases:**
- happy: file is valid TS, imports resolve once `vite` devDep installed
- edge: no plugins needed since no framework
- error: n/a (default config)
**Acceptance:** file exists, exports a valid Vite config via `defineConfig`.

### T4 — index.html
**Deps:** T1
**Files:** `apps/drive-sync-oauth-tester/index.html`
**Do:** Create entry HTML with GIS script BEFORE module script:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>drive-sync OAuth tester</title>
</head>
<body>
  <h1>drive-sync OAuth tester</h1>
  <button id="connect-btn">Connect</button>
  <button id="disconnect-btn">Disconnect</button>
  <button id="pick-btn" disabled>Pick File</button>
  <div id="status">
    <p>State: <span id="state">unknown</span></p>
    <p>Email: <span id="email">-</span></p>
    <p>Expires: <span id="expires">-</span></p>
  </div>
  <ul id="picked-files"></ul>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```
`pick-btn` starts `disabled` in markup (belt-and-suspenders with T5's runtime gating per Resolved decisions #16). No Picker API script tag — `ensurePickerLoaded()` lazy-loads it internally (decision #20).
**Test cases:**
- happy: GIS script tag appears strictly before the module script tag in file order
- edge: has ids `connect-btn`, `disconnect-btn`, `pick-btn`, `state`, `email`, `expires`, `picked-files` — must match what `main.ts` queries in T5
- edge: `pick-btn` has the `disabled` attribute in the initial markup
- error: no other UI elements, no CSS framework link, no Picker API `<script>` tag
**Acceptance:** file exists, script ordering correct, all element ids present including `pick-btn` and `picked-files`, `pick-btn` disabled by default.

### T5 — src/main.ts app logic
**Deps:** T2, T4
**Files:** `apps/drive-sync-oauth-tester/src/main.ts`
**Do:** Implement:
- `Logger` object: `debug/info/warn` → `console.debug/info/warn` (prefixed e.g. `[drive-sync]`), `error` → `console.error`.
- Constants: `const APP_ID = 'drive-sync-oauth-tester'`, `const FOLDER_PATH = ['OAuthTester']`, `const PROJECT_ID = 'oauth-tester'`.
- `const drive = createDriveSync({ appId: APP_ID, clientId: import.meta.env.VITE_DRIVE_CLIENT_ID, folderPath: FOLDER_PATH, logger })`.
- On module load: call `drive.activate()` (store the returned dispose fn, unused but referenced so it's clear it's available), `await drive.reconcile([PROJECT_ID])`.
- `const p = drive.project(PROJECT_ID)`.
- `renderStatus(conn: Connection | null)` function updating `#state`, `#email`, `#expires` DOM text (expiry formatted via `new Date(expiresAt).toLocaleString()` or "-" when null; state text "connected"/"disconnected" based on `conn !== null`); also sets `pick-btn`'s `disabled` property (`false` when `conn !== null`, `true` otherwise) so the button's enabled state stays in sync with connection state on every call, not just on load.
- On load: `const conn = await p.getConnection(); renderStatus(conn);`
- Connect button click handler: `await p.connect()` then `renderStatus(result)`; wrap in try/catch logging errors via logger.error and leaving status unchanged/showing error state.
- Disconnect button click handler: `await p.disconnect()` then `renderStatus(null)` (this also disables `pick-btn` via `renderStatus`), then clear `#picked-files` (`innerHTML = ''` or equivalent) per Resolved decisions #21; wrap in try/catch for logging only — `disconnect()` is already idempotent (clears connection/token unconditionally, only revokes a token if one is cached), so no pre-check via `getConnection()` is needed.
- Pick File button click handler: `await p.pickFile({ apiKey: import.meta.env.VITE_DRIVE_PICKER_API_KEY, appId: import.meta.env.VITE_DRIVE_PICKER_APP_ID, multiSelect: true })` (no `mimeTypes`, no `parentFolderId`, per Resolved decisions #17); on success, render each result's `fileId`, `name`, `mimeType` as a list item in `#picked-files` (never render `content`, per decision #18); wrap in try/catch — if the caught error is a `PickerCancelledError`, log at `info` level and otherwise no-op (leave `#picked-files` untouched, no error UI, per decision #19); any other error, log via `logger.error`.
**Test cases:**
- happy: on load with no prior connection, `#state` shows "disconnected", `#email`/`#expires` show "-", `pick-btn` is disabled
- edge: on load with a prior persisted connection (IndexedDB from earlier session), `#state` shows "connected" with real email/expiry, `pick-btn` is enabled, no reload-needed
- error: clicking Disconnect while already disconnected does not throw an uncaught exception (verify in browser console — no red error; expected, since `disconnect()` is idempotent), UI stays in disconnected state, `pick-btn` stays disabled
- happy: after Connect, `pick-btn` becomes enabled; clicking it and completing a multi-select pick renders each result's `fileId`/`name`/`mimeType` in `#picked-files`, `content` never appears in the DOM
- edge: cancelling the picker (no selection) leaves `#picked-files` and connection status unchanged, logs at `info` level, no thrown/uncaught error
- edge: clicking Disconnect after a successful pick clears `#picked-files` in addition to reverting connection status
**Acceptance:** file exists, type-checks under T2's tsconfig, wires all five lifecycle calls (`activate`, `reconcile`, `getConnection`, `connect`/`disconnect`, `pickFile`), button handlers attached via `document.getElementById` including `pick-btn`, `pick-btn`'s disabled state tracks connection state, `PickerCancelledError` handled as benign.

### T6 — .env.local.example
**Deps:** T1
**Files:** `apps/drive-sync-oauth-tester/.env.local.example`
**Do:** Write three lines:
```
VITE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_DRIVE_PICKER_API_KEY=your-picker-api-key
VITE_DRIVE_PICKER_APP_ID=your-gcp-project-number
```
**Test cases:**
- happy: file committed, contains placeholders not real secrets
- edge: variable names match exactly what `main.ts` reads (`VITE_DRIVE_CLIENT_ID`, `VITE_DRIVE_PICKER_API_KEY`, `VITE_DRIVE_PICKER_APP_ID`)
- error: no real client ID, API key, or project number accidentally included
**Acceptance:** file exists with all three correct var names and placeholder values.

### T7 — Update root .gitignore
**Deps:** T0
**Files:** `/home/mohan/owa/owa/.gitignore` (worktree copy)
**Do:** Append `.env.local` (or `.env*.local` to cover future per-mode env files) as a new line.
**Test cases:**
- happy: `git check-ignore apps/drive-sync-oauth-tester/.env.local` (after creating a dummy one) returns the path, confirming it's ignored
- edge: `.env.local.example` from T6 is NOT ignored (different name, doesn't match pattern) — confirm with `git check-ignore` returning nothing for it
- error: pattern doesn't accidentally ignore unrelated files (e.g. don't use bare `.env*` if repo has other legitimate `.env`-prefixed tracked files — check first with `git ls-files | grep -i env`)
**Acceptance:** `.gitignore` updated, `.env.local` ignored, `.env.local.example` still tracked.

### T8 — Install deps and verify build
**Deps:** T1, T2, T3, T4, T5, T6, T7
**Files:** none (verification only, may touch root `package-lock.json`/lockfile as a side effect of install)
**Do:** From worktree root: `npm install`, then `npm run build -w apps/drive-sync-oauth-tester` (or `cd apps/drive-sync-oauth-tester && npx vite build`). Fix any type errors or import errors surfaced.
**Test cases:**
- happy: `npm install` completes without error, resolves `@open-webapp/drive-sync` as a workspace link
- edge: `vite build` succeeds and emits `dist/` inside the app dir
- error: if build fails on `import.meta.env` typing, confirm T2's `types: ["vite/client"]` is actually applied (rerun `tsc --noEmit`)
**Acceptance:** `npm install` exits 0, `vite build` exits 0, `apps/drive-sync-oauth-tester/dist/` produced.

### T9 — Manual OAuth verification (human-in-the-loop)
**Deps:** T8
**Files:** none (manual testing only; requires human with a real Google Cloud OAuth client ID configured with authorized JS origin `http://localhost:5173`)
**Do:** Human copies `.env.local.example` to `.env.local`, fills in a real `VITE_DRIVE_CLIENT_ID`, `VITE_DRIVE_PICKER_API_KEY`, and `VITE_DRIVE_PICKER_APP_ID` (Google Picker API must be enabled in the GCP project — see Risks). Run `npm run dev -w apps/drive-sync-oauth-tester` (or `cd apps/drive-sync-oauth-tester && npx vite`). Open `http://localhost:5173` in a browser and walk through the checklist below.
**Test cases:**
- happy (a): initial load shows "disconnected" status, no email/expiry
- happy (b): click Connect → Google consent popup appears → after granting, status updates in-place (no reload) to connected + real account email + a future expiry time
- happy (c): click Disconnect → status reverts to disconnected, email/expiry cleared
- edge (d): click Connect again, then reload the page (F5) → status still shows connected with the same email (proves IndexedDB persistence + getConnection()-on-load restore works)
- edge (e): devtools console shows logger `info`/`debug` output during connect/disconnect (confirms Logger wiring)
- error (f): click Disconnect when already disconnected → no-op, no uncaught exception, button remains functional (expected — `disconnect()` is idempotent by design, see Resolved decisions #13)
- happy (g): while disconnected, `pick-btn` is disabled (cannot click it / attribute present)
- happy (h): click Connect, then confirm `pick-btn` becomes enabled without a reload
- happy (i): click Pick File, select 2+ files in the picker dialog, confirm — all selected files' `fileId`/`name`/`mimeType` render in `#picked-files`, no `content` field visible anywhere
- edge (j): click Pick File, then press Escape/cancel in the picker dialog → no error shown, no change to `#picked-files` or connection status, devtools console shows an `info`-level cancellation log
- edge (k): after a successful pick (from (i)), click Disconnect → `#picked-files` is cleared along with connection status reverting to disconnected
**Acceptance:** all eleven checklist items pass and are confirmed by the human tester; any failure is logged as a follow-up bug (not silently ignored) before proceeding to commit.

### T10 — Commit
**Deps:** T1, T2, T3, T4, T5, T6, T7, T8, T9
**Files:** none (git only) — stages everything under `apps/drive-sync-oauth-tester/**` and the `.gitignore` change only
**Do:** `git status` to review. `git add apps/drive-sync-oauth-tester .gitignore`. Commit with message describing the new manual OAuth tester app. Do NOT stage `package-lock.json` — repo state already shows it deleted at the root, unrelated to this change; leave that alone for the user to handle separately, don't fold its deletion (or a regenerated version) into this commit.
**Test cases:**
- happy: `git status` after commit shows only expected untracked artifacts (`dist/`, `node_modules/`) which are gitignored
- edge: diff confirms `packages/drive-sync/**` and `packages/project-sync/**` are completely untouched
- error: no `.env.local` file present in the commit (verify via `git show --stat HEAD`); `package-lock.json` not staged
**Acceptance:** commit exists on branch `drive-sync-oauth-tester/add-app`, `git status` clean apart from the pre-existing unrelated `package-lock.json` deletion, `.env.local` absent from commit, `packages/drive-sync/**` untouched.

### T11 — Cleanup git worktree
**Deps:** T10
**Files:** none (git only)
**Do:** `cd /home/mohan/owa/owa`, then `git worktree remove ../worktree-drive-sync-oauth-tester`.
**Test cases:** n/a
**Acceptance:** worktree removed, original directory active (`/home/mohan/owa/owa`), branch `drive-sync-oauth-tester/add-app` still exists with the commit (`git log drive-sync-oauth-tester/add-app -1`).

## Test strategy
No automated tests by design — this is a manual testing harness, not production code. Verification is entirely T9's human-driven checklist against real Google OAuth infrastructure, preceded by mechanical checks (T8: `npm install` + `vite build` succeed, `tsc --noEmit` clean) that catch wiring/type errors before a human wastes time on the manual pass. End-to-end confidence comes from T9 items (a)-(f) covering: initial state, successful connect, successful disconnect, persistence across reload, logger visibility, and idempotent disconnect-when-already-disconnected. Picker coverage is folded into the same T5 (implementation) and T9 (manual checklist, items (g)-(k)) rather than a separate task.

## Risks
- OAuth requires a real Google Cloud OAuth client ID with `http://localhost:5173` (Vite's default dev port) registered as an authorized JavaScript origin, or the consent popup will fail with a redirect/origin mismatch error. This is an external manual setup step (Google Cloud Console) outside this plan's tasks — call it out to whoever runs T9, and if Vite picks a different port (5173 is in use), that port must also be authorized.
- Picker requires its own Google Cloud provisioning, separate from the OAuth client ID above: a `VITE_DRIVE_PICKER_API_KEY` (API key) and `VITE_DRIVE_PICKER_APP_ID` (GCP project number), plus the Google Picker API enabled in that GCP project. This is an external manual setup step that must be done before T9's picker checklist items (g)-(k) can be exercised.
- `packages/drive-sync`'s internal GIS/token code (`src/gis.ts`) is assumed to expect `window.google` present at call time; if it actually lazy-loads or polls, the strict script-ordering requirement in T4 may be unnecessary but is harmless either way — kept as a safety measure.
- No CI enforcement means this app can silently bit-rot (e.g. drive-sync API changes break it) with nothing catching it automatically — accepted tradeoff per explicit "no automated tests, no CI" requirement.
- `npm install` at the workspace root may touch/regenerate `package-lock.json`; the repo's git status already shows it deleted at session start, unrelated to this plan — T10 explicitly excludes it from the commit rather than resolving or restoring it, since that's the user's call to make separately.

## Post-change doc updates
- No updates to `packages/drive-sync/README.md` or SPEC.md — deliberately out of scope, since a docs-only edit there still matches CLAUDE.md's `packages/drive-sync` auto-tag path trigger and this app doesn't change the library's behavior or public API.
- No AGENTS.md or other cross-cutting doc changes needed; this is a new leaf workspace app with no downstream consumers.

## Manual verification: server-facilitated token exchange (drive-sync 0.6.0)

This is a **manual** pass — it needs a real Google account, a real `VITE_DRIVE_CLIENT_ID` that
**equals the server's `GOOGLE_CLIENT_ID`**, and a running `vite` dev server driven from a browser
with devtools open. It cannot be run by an automated agent.

**Setup:**
1. Copy `apps/drive-sync-oauth-tester/.env.local.example` to `apps/drive-sync-oauth-tester/.env.local`.
2. Set `VITE_DRIVE_CLIENT_ID` to the OAuth client ID that matches the server's `GOOGLE_CLIENT_ID`
   (the server rejects an id it did not issue the code for).
3. Set `VITE_DRIVE_TOKEN_EXCHANGE_URL=/callback` so the library routes the code exchange through
   the Vite dev proxy instead of the legacy GIS implicit flow.
4. Start the dev server: `npm run dev -w apps/drive-sync-oauth-tester` (the `dev` script is `vite`,
   per `apps/drive-sync-oauth-tester/package.json`). Open the printed URL (default
   `http://localhost:5173`) with devtools open on the Console, Network, and Application tabs.
5. Note: `apps/drive-sync-oauth-tester/vite.config.ts` proxies `/callback` to
   `https://open-webapp.duckdns.org` with `changeOrigin: true` and a forced
   `Origin: https://open-webapp.github.io` header — the proxy **spoofs that Origin** because the
   server's CORS allowlist only admits `github.io` origins, and a raw `localhost` Origin would be
   rejected.

**Checks:**

- [ ] 1. Click **Connect** → a Google authorization-code popup opens → complete consent → popup
  closes and the UI shows connected.
  - Expected: in devtools **Application → IndexedDB**, the drive-sync `auth` store holds an
    `envelope` key (v2 record, `guid` is a uuid) **plus** a derived `token` key **plus** a `conn`
    key. The `/callback` request in the Network tab returns the envelope, not a bare access token.
  - Observed:
- [ ] 2. Force-expire the token: in devtools edit the stored `envelope` record and set
  `payload.expiry_date` to `Date.now() - 1000`, then trigger a Drive call or just re-focus the tab.
  - Expected: `refreshEnvelope` issues a `POST` to `/callback` with body `{ envelope }`; the
    response carries a fresh access token; `token.expiresAt` advances to a future time; the
    `envelope` record is replaced in place with the **same `guid`**.
  - Observed:
- [ ] 3. Click **Disconnect**.
  - Expected: the Network tab shows a `POST` to Google's `revoke` endpoint carrying the current
    access token; afterwards the `conn`, `token`, and `envelope` keys are **all gone** from the
    IndexedDB `auth` store.
  - Observed:
- [ ] 4. Simulate a `410` from the exchange endpoint: temporarily repoint the `/callback` proxy
  target at a stub that returns `410` with body `{ error: { code: 'refresh_token_revoked' } }`
  (or use a server test `guid` that is known-revoked), then trigger a refresh.
  - Expected: the next `refreshEnvelope` clears all three keys (`conn`, `token`, `envelope`) and
    surfaces a re-consent prompt / `NeedsReauthError` to the app rather than looping or hanging.
  - Observed:

Status: NOT YET RUN — requires manual execution (see plan T16).
