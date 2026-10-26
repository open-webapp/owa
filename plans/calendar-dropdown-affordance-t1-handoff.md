# Calendar dropdown affordance — T1 baseline handoff

Date: 2026-10-26. Worktree: `/home/mohan/owa/worktree-calendar-fix-dropdown-affordance`.
Branch: `fix/calendar-dropdown-affordance`.
Scope of this continuation: approved dependency-build prerequisite and baseline only.
Reference plan (read only): `/home/mohan/owa/owa/plans/calendar-fix-dropdown-affordance.md`.

## RCA resolution

The previously reported missing `@open-webapp/drive-sync` entry and `/testing` output were a fresh-worktree build prerequisite, not a product regression. Its package exports point into `dist`; CI builds drive-sync before drive-connect tests. Building drive-sync alone resolved the blocker: all workspace tests subsequently loaded and passed. No other dependency build was needed. Dependency installation and Chromium provisioning had already succeeded before this continuation.

## Executed commands and results

All commands ran in the worktree above, in this order; all exited 0.

1. `npm run build --workspace @open-webapp/drive-sync` — TypeScript build passed.
2. `npm run test` — 67 files, 859 tests passed:
   - drive-sync: 33 files / 292 tests.
   - drive-connect: 2 files / 35 tests.
   - project-sync: 13 files / 231 tests.
   - calendar: 19 files / 301 tests.
3. `npm run test:theme-browser --workspace @open-webapp/calendar -- --no-cache` — Chromium suite executed; 1 file / 33 tests passed.
4. `./scripts/check-contracts.sh` — `contracts OK`.

Combined unit/browser result: 68 files / 892 tests passed, no failing tests. Non-failing output included npm's `-ws` deprecation warning, React `act(...)` warnings, and diagnostics from passing project-sync error-path tests.

## Gate and state

T1 baseline is green. T2 and implementation have not started. No production, test, dependency manifest, lockfile, version, or original-plan edits were made; this handoff is the only authored metadata change. The build generated local ignored drive-sync output. No commits, pushes, PRs, or tags were made.

## T2 narrow RCA followup — 2026-10-26

The preceding gate/state describes T1 only. Current T2 changes were read before this followup: two test files, 150 insertions / 3 deletions. The unexpected footer focus failure was a harness limit: `richProps()` renders event title/Join links in addition to RSVP controls before the footer, so ten native Tabs stopped at Join rather than reaching the combobox.

Replaced only the arbitrary ten-Tab bound with the count of rendered, enabled, nonnegative-tabIndex focusable candidates in the mounted host. Traversal still uses actual `userEvent.tab()` from the pointer-clicked Before button, and asserts actual activeElement and `:focus-visible`; no programmatic focus was substituted. Rich event fixtures and all appearance assertions remain intact.

Commands rerun from this worktree (both exit 1 for intentional reds):

1. `npm run test --workspace @open-webapp/calendar -- src/react/__tests__/CalendarSelector.test.tsx` — 11 passed, 1 expected failure: `keeps the full combobox name and relationships with a decorative chevron`, `decorative chevron: expected null not to be null` (line 27).
2. `npm run test:theme-browser --workspace @open-webapp/calendar -- --no-cache -t affordance` — 8 expected failing affordance cases, 33 unrelated tests skipped. Four geometry cases cover long name/multi-account count at 360/1000px; four hover/keyboard cases cover footer/standalone in light/dark. Native Tab now reaches the trigger in all four focus cases; pointer focus, keyboard modality, Enter/Space opening, Escape focus return, ARIA relationships and no-selection callbacks produce no failures. All remaining failures are visual.

Expected visual reds: missing chevron; native inline-block rather than inline-flex with centered alignment/8px gap; min-height 0 rather than 36px (count trigger renders 21px); padding 1px 6px rather than 8px 12px; radius 0 rather than 6px; default rather than pointer cursor; native 2px outset rather than 1px solid border; native 13.3333px Arial rather than inherited font; native text/surface rather than approved theme colors; no hover background change (light also misses hover token); keyboard outline auto/1px/0px offset/rgb(16,16,16) rather than solid/2px/2px offset/theme accent. Long-label wrapping grows footer height to 151px at 360px and 91px at 1000px rather than 64px: approved expected long-label containment regression, not a new harness blocker.

Browser output: `/home/mohan/.local/share/opencode/tool-output/tool_178d45d4c001v9knWxPmkJ8Cxm`. No unexpected test failures remain. Geometry tests' hard footer-height assertion stops later theme iterations for long-name cases until implementation fixes wrapping; the unit chevron assertion similarly precedes later relationship assertions in that test.

Current implementation handoff: `CalendarSelector.test.tsx` adds 21 lines for full accessible name, decorative nonfocusable chevron and combobox relationships; `calendarTheme.browser.test.tsx` adds 134 lines / removes 3 for geometry, themed appearance, containment, real hover and keyboard interaction coverage (including this bounded-traversal repair). Combined test diff: 155 insertions / 3 deletions. This followup adds 5 net test lines. No production edits or commits were made. T2 remains intentionally red for implementation.

## T3 narrow resting-palette RCA followup — 2026-10-26

Input evidence supplied for this continuation: T3 shared trigger class/label/decorative SVG and scoped geometry/theme states were applied; calendar units passed 302 tests, focused affordance browser cases passed 8 tests, but full browser execution passed 30 and failed 11. The shared `selectorPalette()` resting-surface assertion (previous line 218) observed light `rgb(240, 248, 251)` instead of `rgb(255, 255, 255)`, and dark `rgb(42, 42, 42)` instead of `rgb(26, 26, 26)`.

RCA classification: incorrect harness state precondition exposed by the approved hover behavior. Real `userEvent.click()` leaves the pointer over the trigger; focus moving to search does not remove CSS `:hover`. The observed colors exactly match the approved hover tokens, not an incorrect resting palette. Existing call sites confirmed they checked the palette directly after clicking, including live OS and nested-theme coverage.

Changed only browser harness code: make `selectorPalette()` async, move the real pointer to the scoped open searchbox with `await userEvent.hover(...)` before checking the resting palette, and await all four call sites. This preserves focus, the open dropdown and every exact palette assertion. Separate real trigger-hover assertions remain intact. Incremental harness diff: 7 insertions / 5 deletions. Existing production and unit-test edits were preserved.

Validation ran once each, in order, from this worktree; both exited 0:

1. `npm run test:theme-browser --workspace @open-webapp/calendar -- --no-cache` — 1 file / 41 tests passed, zero failures or skips (including all 8 affordance cases).
2. `npm run test` — 67 files / 860 tests passed: drive-sync 33/292; drive-connect 2/35; project-sync 13/231; calendar 19/302.

Combined result: 68 files / 901 tests passed. Non-failing output included existing React act warnings, npm's `-ws` deprecation warning and passing project-sync error-path diagnostics. No unexpected failures, retries, other fixes or commits. Followup plan note: `plans/calendar-dropdown-affordance-resting-palette-followup.md`. This resolves the T3 palette gate only; later implementation-plan tasks were not executed in this continuation.

## T4 reference docs and version — 2026-10-26

Read root instructions, parent plan, both handoffs and all four calendar reference docs in full; inspected the existing T3 trigger/CSS diff. Updated product behavior, design Decisions and README Footer calendar selection/Theme behavior/Host CSS plus the 0.5.1 patch note to describe the actual shared trigger geometry, themed surface/hover/focus, decorative chevron and label containment. Documented the approved visual-only exception, preserved default 64px footer/6px clearance, and explicitly retained interaction/accessibility/selection contracts.

Reference sweep: searched all four existing docs before and after edits with `CalendarSelector|GroupedCalendarSelector|calendar-selector-trigger|chevron|geometry|layout|native|footer` (24 matching lines before, 30 after). Reconciled current blanket geometry/layout-preservation claims in product behavior and design, and clarified README's single-trigger layout claim as structural preservation with the visual exception. README's 0.5.0 layout-preservation release note remains a historical statement about that release. SPEC UI contract and Styling were inspected: they impose no native trigger geometry requirement; their palette tokens/isolation, behavioral and schema claims remain valid and unchanged. No SPEC edits or schema-spec.md creation.

Release recheck: `git fetch origin main` succeeded; current `origin/main` is `43308b7ebd67ebb0c575cc27b35530ecef9048aa`, calendar 0.5.0. `npm view @open-webapp/calendar versions dist-tags peerDependencies peerDependenciesMeta --json` reports latest 0.5.0 and no 0.5.1. Local tags and `git ls-remote --tags origin 'calendar-v*'` both end at calendar-v0.5.0. Selected next unused patch **0.5.1**; changed only package.json version and existing root lockfile `packages/calendar.version`. The workspace link entry has no version metadata to update. No dependency ranges/resolutions or other lock entries changed.

Peer evidence: published calendar peers are React `^19` and optional Vitest `^2.1.0`, matching local manifest/lock metadata. Registry queries confirm published React 19.3.1 and Vitest 2.1.9; `npm ls react vitest --workspace @open-webapp/calendar --depth=0` exits 0 and resolves those same compatible versions. Calendar declares no workspace peer dependency; no peer bump is needed.

T4 acceptance: `git diff --check` passed; inspected manifest/lock diff shows exactly the two 0.5.0 -> 0.5.1 version substitutions and no dependency churn. Existing source/tests were preserved. T3's 860 workspace + 41 browser green evidence remains above; T5 test/build/contracts validation was not executed in this docs/version-only continuation. No unexpected check failures. No commits, pushes, PRs, tags or release actions.

## T5 validation only — 2026-10-26

Read root instructions, parent plan and both handoffs. All required commands executed once in the following order and exited 0:

1. `npm run test` — 67 files / 860 tests passed: drive-sync 33/292; drive-connect 2/35; project-sync 13/231; calendar 19/302. Full command output is captured in the session tool results.
2. `npm run test --workspace @open-webapp/calendar` — 19 files / 302 tests passed.
3. `npm run test:theme-browser --workspace @open-webapp/calendar -- --no-cache` — 1 file / 41 tests passed, no failures/skips, including eight affordance cases and existing interaction/theme/geometry coverage.
4. `npm run build` — all five workspace builds passed. Calendar ran `tsc && cp src/react/styles.css dist/styles.css`, providing its applicable typecheck.
5. `./scripts/check-contracts.sh` — `contracts OK`.

Reinspected root and all five workspace package scripts: no lint or standalone typecheck/check script is defined. No invented lint/typecheck command was run. Existing non-failing React act warnings, npm `-ws` deprecation warning and passing project-sync error-path diagnostics remain.

Inspected copied `packages/calendar/dist/styles.css:427–469`: inline-flex border-box centered trigger, 8px gap, 36px min-height, 8px/12px padding, 1px themed border, 6px radius, inherited font, pointer cursor, themed hover, 2px focus-visible outline/offset, ellipsized label and fixed 12px nonshrinking chevron are present. `git ls-files packages/calendar/dist` returned no tracked files; `git check-ignore packages/calendar/dist/styles.css` confirmed it is ignored. No generated files were staged.

Visual inspection actually performed using image-read tools on the original `/home/mohan/Downloads/Screenshot_2026-10-26_00-10-41.png` and all four new Chromium screenshots:

- `/tmp/opencode/calendar-t5-light-360.png`
- `/tmp/opencode/calendar-t5-dark-360.png`
- `/tmp/opencode/calendar-t5-light-1000.png`
- `/tmp/opencode/calendar-t5-dark-1000.png`

Scratch reproduction: `node /tmp/opencode/calendar-t5-visual.mjs` (exit 0). It renders actual built CalendarPane/CalendarSelector static React markup with copied dist CSS in Playwright Chromium; screenshots are resting-state package fixtures, not the deployed host. Footer count and standalone long label are shown at both viewport widths/themes, using 328px/720px hosts. Compared with the original tiny squared native button, all four visibly show padded rounded outlined controls and a clear chevron; long labels ellipsize without losing the chevron or overflowing. Both triggers measured 36px high, chevrons 12px wide, footer 64px high. Light surface was rgb(255,255,255), dark rgb(26,26,26). Visual screenshot checks cover resting appearance; real hover/focus/open/close/dropdown-clearance evidence comes from the passing browser suite, not these static fixtures.

Verified existing red-before-green evidence above: T2 deliberate unit chevron and eight browser visual assertion reds, T3 full 860-unit/41-browser green, and fresh T5 greens. Missing-dist RCA (build prerequisite), Tab-limit RCA (rendered tabbable count), and pointer-hover palette RCA (move real pointer before resting assertion) are all recorded above. T4's four-reference doc sweep and visual-only exception reconciliation are recorded above.

`git diff --check` passed before this evidence append. No unexpected failures or blockers. T5 accepted; no production/test/version edits, commits, staging, pushes, PRs or tags performed in this continuation. Only this handoff evidence was appended inside the worktree; scratch script/images live outside it.
