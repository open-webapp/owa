# Plan: drive-sync-picker

## Goal
App devs using `@open-webapp/drive-sync` want users to browse and pick files from their own Google Drive, not just read files the app already knows the id of. We add `p.pickFile(options)` on `ProjectHandle`. It opens the Google Picker UI, lets the user pick file(s), then pre-fetches each picked file's content using the existing `files.ts` read path, and returns that content along with id/name/mimeType. Cancel throws a typed error. Script loading for the Picker JS is lazy and cached once per process. This is additive only, no breaking changes, minor version bump.

## Scope
**In scope:**
- New `pickFile()` method on `ProjectHandle` in `src/index.ts`.
- New `src/picker.ts`: lazy script loading (cached), `PickerBuilder` wiring, PICKED/CANCEL handling.
- New `PickerCancelledError` in `src/errors.ts`.
- New `PickFileOptions` / `PickedFile` types in `src/types.ts`, re-exported from `src/index.ts`.
- New `src/testing/pickerFake.ts`, wired into `src/testing/index.ts`.
- New `src/__tests__/picker.test.ts`.
- Update `src/__tests__/testing-exports.test.ts`.
- `package.json` version bump `0.2.0` -> `0.3.0`.
- `README.md` and `SPEC.md` doc updates.

**Out of scope:**
- New npm dependency for Picker/gapi types (hand-write ambient types instead).
- New `/picker` export subpath or new package.
- Adding `apiKey` to `DriveSyncOptions`/`createDriveSync()`.
- Upload-new-file picker views (browsing existing files only, v1).
- Any change to `FilesHandle`/`PermissionsHandle`/`getAccessToken` signatures.

## Resolved decisions
1. `pickFile()` lives inside the `project(projectId)` closure in `src/index.ts`, closes over `base = { appId, projectId, clientId, logger, fetchEmail }`, same pattern as `files`/`permissions` delegating to `filesImpl`/`permissionsImpl`.
2. `apiKey` is passed per-call inside `pickFile(options)`, not part of `DriveSyncOptions`. `src/types.ts`'s `DriveSyncOptions` is untouched.
3. Options shape: `{ apiKey: string; mimeTypes?: string[]; multiSelect?: boolean; parentFolderId?: string }`. Default = whole Drive, single-select, no mimeType filter.
4. Return shape: `Promise<{ fileId: string; name: string; mimeType: string; content: string | Blob | null }[]>`. Content comes from calling existing `filesImpl.read()` per picked file — reuse `string | Blob | null` union and null-on-404 semantics verbatim, no new fetch logic.
5. Cancel (no selection) throws `PickerCancelledError extends DriveSyncError`, defined in `src/errors.ts` matching the exact existing subclass pattern (`this.name = 'PickerCancelledError'`, default message `'Picker cancelled by user'`).
6. Script loading (`https://apis.google.com/js/api.js` then `gapi.load('picker', ...)`) is cached at MODULE level in `src/picker.ts` as a single shared promise — reused across all `pickFile()` calls, all projects, never re-injects `<script>` tag.
7. `index.ts`'s `pickFile()` calls `getAccessTokenImpl` from `connection.ts` itself (same as its own existing `getAccessToken()` method does), with `interactive: true` always (Picker is always live user UI, no `interactive` option in `PickFileOptions`). It then passes the raw token string + `apiKey` + options into `pickerImpl.openPicker(...)`. `picker.ts` itself never touches storage/`connection.ts` — it takes a plain token string as input. This mirrors how `files.ts`/`permissions.ts` never call `connection.ts` directly.
8. `PickedFile` / `PickFileOptions` types live in `src/types.ts` (consistent with `FileRef`/`DrivePermission`), re-exported via `index.ts`'s existing `export * from './types.js'` line.
9. `createPickerFake()` in `src/testing/pickerFake.ts` mirrors `gisFake.ts`'s shape: `{ calls, simulatePick([...]), simulateCancel(), install(), uninstall(), reset() }`. It stubs `window.google.picker` (`PickerBuilder`, `DocsView`, `Action`, `ViewId`) AND `window.gapi.load` so `picker.ts`'s lazy-load path resolves without a real network fetch. `install()`/`uninstall()` save/restore prior global state exactly like `gisFake.ts` does for `window.google`.
10. `picker.ts`'s script-injection function checks whether `window.gapi`/`window.google.picker` are already present and skips injecting a live `<script>` tag when present, so it is mockable in tests without network calls.
11. No new npm dependency for Google Picker/gapi types — `picker.ts` declares its own minimal ambient types (`declare global { interface Window { gapi: ...; google: ... } }`) for the subset of the API it uses.
12. Version bump is `0.2.0` -> `0.3.0` (minor, additive-only). No existing exported signature changes.
13. SPEC.md's "34 resolved design decisions" section gets ONE new combined decision appended (item 35, covering apiKey-per-call, the token-boundary split between `index.ts`/`picker.ts`, `PickerCancelledError`, and script-load caching as a single cohesive entry — not split into multiple numbered items), heading retitled to "35 resolved design decisions". README.md's "the 34 resolved decisions" reference is updated to match.
14. `picker.ts` exports a test-only reset hook (e.g. `__resetPickerScriptCacheForTests()`) that clears the module-level `scriptLoadPromise` cache, so test files that exercise the real script-loading path get a clean slate instead of sharing one cache for the whole vitest run.
15. `mimeTypes` in `PickFileOptions` accepts both literal MIME strings and built-in shorthand tokens for Google Workspace native types (e.g. `'docs' | 'sheets' | 'slides' | 'forms' | 'drawings'`), expanded internally in `picker.ts` to the corresponding `application/vnd.google-apps.*` strings before being handed to `setMimeTypes()`. Literal MIME strings pass through unchanged.
16. Browsing-only for v1 — no "upload new file" Picker view (`DocsUploadView`) in this plan. `parentFolderId` only scopes browsing. Deferred until an app actually needs upload-through-Picker.

## Affected files
- `packages/drive-sync/src/errors.ts` — add `PickerCancelledError` class.
- `packages/drive-sync/src/types.ts` — add `PickFileOptions`, `PickedFile` types.
- `packages/drive-sync/src/picker.ts` — NEW file: script-load caching + `openPicker()` implementation.
- `packages/drive-sync/src/index.ts` — add `pickFile()` to `ProjectHandle` interface + closure implementation; import `pickerImpl`.
- `packages/drive-sync/src/testing/pickerFake.ts` — NEW file: `createPickerFake()`.
- `packages/drive-sync/src/testing/index.ts` — export `createPickerFake` and its types.
- `packages/drive-sync/src/__tests__/picker.test.ts` — NEW file: unit tests.
- `packages/drive-sync/src/__tests__/testing-exports.test.ts` — assert `createPickerFake` export exists.
- `packages/drive-sync/package.json` — version `0.2.0` -> `0.3.0`.
- `packages/drive-sync/README.md` — usage snippet + decision-count reference.
- `packages/drive-sync/SPEC.md` — Public API snippet, files list, decision 35, heading retitle.

## Tasks

### T0 — Create git worktree
**Deps:** none
**Files:** none (git only)
**Do:** From `/Users/mdoraiswamy/owa/owa`, run `git worktree add ../worktree-drive-sync-picker -b feature/drive-sync-picker`, then `cd ../worktree-drive-sync-picker`. All following tasks happen inside this worktree, at `packages/drive-sync/` under it.
**Test cases:** n/a
**Acceptance:** worktree exists at `../worktree-drive-sync-picker`, branch `feature/drive-sync-picker` checked out, cwd is the worktree.

### T1 — Add PickerCancelledError
**Deps:** T0
**Files:** `packages/drive-sync/src/errors.ts`
**Do:** Read the file to confirm current subclass pattern. Add:
```ts
export class PickerCancelledError extends DriveSyncError {
  constructor(message = 'Picker cancelled by user', opts?: DriveSyncErrorOptions) {
    super(message, opts);
    this.name = 'PickerCancelledError';
  }
}
```
Place it near the other subclasses (alphabetical or grouped, match existing file order).
**Test cases:**
- happy: `new PickerCancelledError()` has `.name === 'PickerCancelledError'` and `.message === 'Picker cancelled by user'`.
- edge: `new PickerCancelledError('custom msg', { status: 499 })` carries custom message and `.status`.
- error: n/a (no error path in a constructor).
**Acceptance:** `tsc --noEmit` passes in `packages/drive-sync`; class exported, `instanceof DriveSyncError` true.

### T2 — Add PickFileOptions / PickedFile types
**Deps:** T0
**Files:** `packages/drive-sync/src/types.ts`
**Do:** Read the file. Add near `FileRef`/`DrivePermission`:
```ts
export type WorkspaceMimeShorthand = 'docs' | 'sheets' | 'slides' | 'forms' | 'drawings';

export interface PickFileOptions {
  apiKey: string;
  mimeTypes?: (string | WorkspaceMimeShorthand)[];
  multiSelect?: boolean;
  parentFolderId?: string;
}

export interface PickedFile {
  fileId: string;
  name: string;
  mimeType: string;
  content: string | Blob | null;
}
```
Do not touch `DriveSyncOptions` or `CallOptions`.
**Test cases:**
- happy: type-checks when constructing a `PickFileOptions` with only `apiKey`.
- edge: type-checks with all optional fields present, including a mix of literal MIME strings and shorthand tokens (e.g. `mimeTypes: ['docs', 'application/pdf']`).
- error: n/a (compile-time only; verify via `tsc --noEmit`).
**Acceptance:** `tsc --noEmit` passes; types exported from `types.ts`.

### T3 — Implement src/picker.ts
**Deps:** T1, T2
**Files:** `packages/drive-sync/src/picker.ts` (new), read `packages/drive-sync/src/connection.ts` and `src/testing/gisFake.ts` for style reference first.
**Do:**
- Declare minimal ambient types for `window.gapi` (`{ load(api: string, cb: () => void): void }`) and `window.google.picker` (`PickerBuilder`, `DocsView`, `Action`, `ViewId`, `Response` shape) scoped to what's used — do not pull in a full gapi type package.
- Module-level `let scriptLoadPromise: Promise<void> | null = null;` and an `ensurePickerLoaded(): Promise<void>` function:
  - if `window.google?.picker` already present, resolve immediately (no injection) — this branch is what the test fake exploits.
  - else if `scriptLoadPromise` set, return it (cache reuse).
  - else create the promise: inject `<script src="https://apis.google.com/js/api.js">`, on load call `window.gapi.load('picker', resolve)`, on script error reject and reset `scriptLoadPromise = null` so a later call can retry.
- Export `__resetPickerScriptCacheForTests(): void` (test-only, but exported normally — no conditional/env-gated export) that sets `scriptLoadPromise = null`, letting a test file force a clean slate on the real loading path instead of relying on a shared cache for the whole vitest run.
- A module-level `const WORKSPACE_MIME_SHORTHAND: Record<WorkspaceMimeShorthand, string>` mapping `docs`/`sheets`/`slides`/`forms`/`drawings` to their `application/vnd.google-apps.*` strings (import `WorkspaceMimeShorthand` from `./types.js`). A small `resolveMimeTypes(mimeTypes?: (string | WorkspaceMimeShorthand)[]): string[] | undefined` helper expands any shorthand token via the map and passes literal MIME strings through unchanged.
- Export `openPicker(opts: { apiKey: string; oauthToken: string; mimeTypes?: (string | WorkspaceMimeShorthand)[]; multiSelect?: boolean; parentFolderId?: string }): Promise<{ fileId: string; name: string; mimeType: string }[]>`:
  - `await ensurePickerLoaded()`.
  - build a `google.picker.DocsView`, apply `resolveMimeTypes(opts.mimeTypes)`/`parentFolderId` if given.
  - `new google.picker.PickerBuilder().setOAuthToken(oauthToken).setDeveloperKey(opts.apiKey).addView(view)`, `.enableFeature(MULTISELECT_ENABLED)` if `multiSelect`.
  - set callback: on `Action.PICKED` resolve with mapped `{ fileId, name, mimeType }[]` from `data.docs`; on `Action.CANCEL` reject with `PickerCancelledError` (import from `./errors.js`).
  - `.build().setVisible(true)`.
**Test cases:** (covered in T7, this task is implementation only — but sanity-check locally)
- happy: `ensurePickerLoaded()` resolves without injecting script when `window.google.picker` pre-set.
- edge: two concurrent `openPicker()` calls before load completes both await the same `scriptLoadPromise`, script injected once; `resolveMimeTypes(['docs', 'application/pdf'])` returns `['application/vnd.google-apps.document', 'application/pdf']`.
- error: script load failure rejects and resets cache so a retry can re-inject; `__resetPickerScriptCacheForTests()` called mid-flight (no pending load) is a no-op, doesn't throw.
**Acceptance:** `tsc --noEmit` passes; `picker.ts` has no import from `connection.ts` (token boundary respected); `openPicker` never reads storage; `__resetPickerScriptCacheForTests` exported.

### T4 — Wire pickFile() into index.ts
**Deps:** T3
**Files:** `packages/drive-sync/src/index.ts`
**Do:**
- Add `import * as pickerImpl from './picker.js'` near existing `import * as filesImpl from './files.js'`.
- In the `ProjectHandle` interface (near `files`/`permissions`, lines ~51-82), add:
  `pickFile(options: PickFileOptions): Promise<PickedFile[]>;`
- In the `project(projectId)` closure's returned object literal (lines ~240-286), add:
```ts
async pickFile(options) {
  const token = await getAccessTokenImpl({ appId, projectId, clientId, scopes: REQUIRED_SCOPES, interactive: true, logger });
  const picked = await pickerImpl.openPicker({
    apiKey: options.apiKey,
    oauthToken: token,
    mimeTypes: options.mimeTypes,
    multiSelect: options.multiSelect,
    parentFolderId: options.parentFolderId,
  });
  const results: PickedFile[] = [];
  for (const p of picked) {
    const content = await filesImpl.read({ ...base, fileId: p.fileId, interactive: true });
    results.push({ fileId: p.fileId, name: p.name, mimeType: p.mimeType, content });
  }
  return results;
},
```
  (adjust exact identifier names — `getAccessTokenImpl`, `base`, `REQUIRED_SCOPES` import from `./files.js` — to match what's already in the file; confirm exact existing `getAccessToken()` method body first via Read and mirror its call shape precisely.)
- Confirm `export * from './types.js'` already covers `PickFileOptions`/`PickedFile` (added in T2) — no extra export line needed.
**Test cases:** (covered fully in T7, sanity here)
- happy: calling `p.pickFile({ apiKey: 'x' })` on a project returns array of `PickedFile`.
- edge: `parentFolderId` passed through unchanged to `pickerImpl.openPicker`.
- error: if `getAccessTokenImpl` rejects (e.g. user denies OAuth), `pickFile()` rejects with that same error, no swallowing.
**Acceptance:** `tsc --noEmit` passes across the package; `pickFile` appears in `ProjectHandle` type and implementation; no change to any other existing method's signature.

### T5 — Implement src/testing/pickerFake.ts
**Deps:** T3
**Files:** `packages/drive-sync/src/testing/pickerFake.ts` (new), read `packages/drive-sync/src/testing/gisFake.ts` fully first for exact pattern.
**Do:**
- `createPickerFake()` returns `{ calls, simulatePick(files), simulateCancel(), install(), uninstall(), reset() }`.
- `install()`: save `hadGapi`/`previousGapi`, `hadGooglePicker`/`previousGooglePicker` off `globalThis`. Stub `window.gapi = { load: (_api, cb) => queueMicrotask(cb) }`. Stub `window.google.picker` with fake `PickerBuilder` (chainable `setOAuthToken`/`setDeveloperKey`/`addView`/`enableFeature`/`build`), fake `DocsView`, `Action = { PICKED: 'picked', CANCEL: 'cancel' }`, `ViewId`. `build()` returns a fake picker object with `setVisible(true)` that, when called, triggers the captured callback either on `simulatePick`/`simulateCancel` invocation (store the callback, don't fire immediately) or immediately if a pick/cancel was pre-queued.
- Record each `PickerBuilder` construction + view/options into `calls` for assertions (mirrors `gisFake.ts`'s call recording).
- `simulatePick(files: { fileId, name, mimeType }[])`: invoke stored callback with `{ action: 'picked', docs: files.map(...) }` via `queueMicrotask`.
- `simulateCancel()`: invoke stored callback with `{ action: 'cancel' }` via `queueMicrotask`.
- `uninstall()`: restore prior `gapi`/`google.picker` state exactly (delete if `had*` was false).
- `reset()`: clear `calls` and any queued callback state, without touching install state.
**Test cases:**
- happy: `install()` then `openPicker()` from `picker.ts` resolves via `simulatePick(...)` with matching mapped fields.
- edge: `install()` twice (idempotency) doesn't lose the "previous" state needed for correct `uninstall()`.
- error: `uninstall()` without prior `install()` doesn't throw; `simulateCancel()` causes `openPicker()` to reject with `PickerCancelledError`.
**Acceptance:** fake exported, type-checks, used successfully by T7's tests.

### T6 — Wire testing/index.ts exports
**Deps:** T5
**Files:** `packages/drive-sync/src/testing/index.ts`
**Do:** Add, matching existing two-line-per-fake pattern:
```ts
export { createPickerFake } from './pickerFake.js'
export type { PickerFake, PickerFakeFile, PickerRecordedCall } from './pickerFake.js'
```
(name the exported types to match whatever T5 actually defines — reconcile naming before writing this line).
**Test cases:** covered by T8.
**Acceptance:** `tsc --noEmit` passes; `./testing` subpath export surface includes `createPickerFake`.

### T7 — Write src/__tests__/picker.test.ts
**Deps:** T4, T6
**Files:** `packages/drive-sync/src/__tests__/picker.test.ts` (new); read `connection.test.ts` and `files.test.ts` first for import/setup style (vitest, `setup.ts` conventions).
**Do:** Write vitest tests covering:
1. Options -> `PickerBuilder` wiring: call `p.pickFile({ apiKey, mimeTypes: ['application/pdf'], multiSelect: true, parentFolderId: 'folder1' })` with `pickerFake` installed and `gisFake`/token stub installed (reuse existing token-acquisition fakes so `getAccessTokenImpl` resolves), assert `pickerFake.calls` shows the view/options/multiselect were set correctly.
2. Pick resolves with pre-fetched content: stub/mock `filesImpl.read` (vi.mock or spy) to return known content per fileId, `simulatePick([...])`, assert resolved array has correct `{ fileId, name, mimeType, content }` per file, content fetched via the read path (assert the spy was called with expected `fileId`).
3. Cancel throws `PickerCancelledError`: `simulateCancel()`, assert `pickFile()` rejects with `PickerCancelledError` (check `instanceof` and `.name`).
4. Script-load caching/dedup: call `__resetPickerScriptCacheForTests()` first for a clean slate, then call `pickFile()` twice (same project and across two different `project(id)` calls from the same `createDriveSync()` instance), assert the script-injection / `gapi.load` stub was invoked only once (track via a spy on the fake's load stub or a call counter in `pickerFake`).
5. `mimeTypes` shorthand expansion: call `p.pickFile({ apiKey, mimeTypes: ['docs', 'application/pdf'] })`, assert `pickerFake.calls` shows the view was set up with `['application/vnd.google-apps.document', 'application/pdf']`.
Call `__resetPickerScriptCacheForTests()` in a `beforeEach`/`afterEach` for this file so its script-load-cache tests never leak state into other test files.
**Test cases:** as enumerated above (happy = #1/#2/#5, edge = #4, error = #3).
**Acceptance:** `vitest run` passes for this file; no leaked global state affecting other test files (verify by running full `vitest run` for the package, not just this file).

### T8 — Update testing-exports.test.ts
**Deps:** T6
**Files:** `packages/drive-sync/src/__tests__/testing-exports.test.ts`
**Do:** Read existing file, add assertion that `createPickerFake` is exported from `../testing/index.js` (matching however `createGisFake`/`createDriveFake` are currently asserted — likely `expect(typeof createPickerFake).toBe('function')`).
**Test cases:**
- happy: `createPickerFake` is a function.
- edge: n/a (pure export-shape test).
- error: n/a.
**Acceptance:** `vitest run src/__tests__/testing-exports.test.ts` passes.

### T9 — Bump package.json version
**Deps:** T4 (feature complete)
**Files:** `packages/drive-sync/package.json`
**Do:** Change `"version": "0.2.0"` to `"version": "0.3.0"`. No other field changes.
**Test cases:**
- happy: `npm pkg get version` (or manual read) shows `0.3.0`.
- edge: `exports` map unchanged (still just `.` and `./testing`).
- error: n/a.
**Acceptance:** version field is `0.3.0`, JSON still valid (`node -e "require('./package.json')"` or equivalent doesn't throw).

### T10 — Update SPEC.md
**Deps:** T4, T7
**Files:** `packages/drive-sync/SPEC.md`
**Do:**
- In the "Public API" code block (~lines 18-44), add a `pickFile` usage example, e.g. `const picked = await p.pickFile({ apiKey: PICKER_API_KEY });`. Revise the existing comment on `const token = await p.getAccessToken();` (line ~35, `// raw token, for Google Picker's setOAuthToken() only`) to note `pickFile()` is now the preferred path for most Picker use, `getAccessToken()` remains for advanced/custom Picker wiring.
- Line ~48 "files implementing the surface" list: add `picker.ts`.
- Section "## 2. The 34 resolved design decisions" (line 52): append ONE combined item 35 covering the picker feature as a whole in the same terse, source-referencing style — apiKey passed per-call not in `DriveSyncOptions`, the token-boundary split (`index.ts` resolves the token via `connection.ts`, `picker.ts` only ever sees a plain string), `PickerCancelledError` on cancel, and module-level script-load caching. Do NOT split into multiple numbered items.
- Retitle heading to "## 2. The 35 resolved design decisions" (or correct final count).
**Test cases:** n/a (docs).
**Acceptance:** SPEC.md renders `pickFile()` in the usage snippet, `picker.ts` in the files list, new numbered decision(s) present, heading count matches actual list length (verify by counting).

### T11 — Update README.md
**Deps:** T10
**Files:** `packages/drive-sync/README.md`
**Do:** In the usage snippet (~lines 13-29) add a `pickFile` example line consistent with SPEC.md's. Update the "the 34 resolved decisions" reference (~line 31) to match SPEC.md's new count from T10.
**Test cases:** n/a (docs).
**Acceptance:** README's decision count matches SPEC.md's heading exactly; `pickFile` example present and consistent with actual method signature.

### T12 — Run full test suite and typecheck
**Deps:** T7, T8, T9, T10, T11
**Files:** none (verification only)
**Do:** From `packages/drive-sync`, run `npx tsc --noEmit` and `npx vitest run`. Fix any fallout before proceeding.
**Test cases:**
- happy: all tests pass, 0 typecheck errors.
- edge: run twice in a row to confirm no test-order-dependent flakiness from picker.ts's module-level cache.
- error: any failure is fixed here, not deferred.
**Acceptance:** `tsc --noEmit` exits 0; `vitest run` exits 0, all suites green including new `picker.test.ts`.

### T13 — Commit
**Deps:** T12
**Files:** none (git only)
**Do:** From the worktree, `git add packages/drive-sync`, commit with a message describing the `pickFile()` addition (mention picker.ts, PickerCancelledError, pickerFake, version bump, doc updates).
**Test cases:** n/a
**Acceptance:** commit exists on `feature/drive-sync-picker`, `git status` clean.

### T14 — Cleanup git worktree
**Deps:** T13
**Files:** none (git only)
**Do:** `cd /Users/mdoraiswamy/owa/owa`, then `git worktree remove ../worktree-drive-sync-picker`.
**Test cases:** n/a
**Acceptance:** worktree removed, original directory `/Users/mdoraiswamy/owa/owa` active, branch `feature/drive-sync-picker` still exists with the commit (verify via `git branch -a` / `git log feature/drive-sync-picker -1`).

## Test strategy
All verification is vitest unit tests inside `packages/drive-sync`, no live Google Cloud credentials needed. New `pickerFake.ts` (mirroring `gisFake.ts`) stubs `window.gapi`/`window.google.picker` so `picker.ts`'s script-loading and `PickerBuilder` wiring run entirely in-process. The content-pre-fetch path reuses/stubs `filesImpl.read` (already covered by `files.test.ts`'s own suite) rather than re-testing Drive fetch semantics — `picker.test.ts` only asserts it's called with the right `fileId`s and that returned content flows through unchanged, including the `null`-on-404 case (simulate a `read` stub returning `null` for one file among several picked, assert it comes through as `null` in the result array, not dropped or replaced). `testing-exports.test.ts` guards the public testing surface. Final gate is T12: full `tsc --noEmit` + `vitest run` for the whole package, run twice to catch order-dependent flakiness from the module-level script-load cache.

## Risks
- Real Google Picker script/API behavior can't be fully verified without live Google Cloud credentials and manual browser testing — mitigation: fake covers wiring/contract only; note in README/SPEC that manual smoke-testing against a real Google Cloud project is recommended before first release consumption.
- `gapi`/`google.picker` have no official npm types package, so ambient types in `picker.ts` are hand-maintained and can drift from the real API if Google changes it — mitigation: keep the ambient type surface minimal (only fields actually used), documented inline.
- The script-load promise cache in `picker.ts` is module-level global state, which complicates test isolation across test files/runs — mitigation: `pickerFake`'s `install()` short-circuits `ensurePickerLoaded()` via the "already present" branch so the real cache is never exercised in most tests; the exported `__resetPickerScriptCacheForTests()` (decision #14) gives T7's dedup test an explicit clean slate instead of relying on run order; T12 runs the suite twice to catch any remaining leakage.
- `getAccessTokenImpl` call inside `pickFile()` duplicates logic already in `getAccessToken()` — mitigation: keep it as a direct call to the same shared `connection.ts` function, no copy-paste of its internals, matching the resolved decision #7.

## Open questions
None. All four questions raised during planning are resolved — see Resolved decisions #13-16: SPEC.md gets one combined decision entry (#13), `picker.ts` exports a test-only script-cache reset hook (#14), `mimeTypes` supports Workspace shorthand tokens (#15), and v1 is browsing-only with no upload view (#16).

## Post-change doc updates
- `packages/drive-sync/README.md`: usage snippet gets a `pickFile` example (T11); "the 34 resolved decisions" line count synced to SPEC.md's new total (T11).
- `packages/drive-sync/SPEC.md`: Public API snippet shows `pickFile()` and revises the `getAccessToken()` comment (T10); "files implementing the surface" list adds `picker.ts` (T10); "## 2. The N resolved design decisions" section gets decision 35 (or more) appended and heading retitled with the correct final count (T10).
Both doc tasks (T10, T11) are part of the ordered task list, not an afterthought — T12's full-suite verification runs after them so doc/code drift is caught before commit.
