# Plan: Calendar independent Unaccepted toggle

## Status
T1a–T5 complete. Final T5 root tests 896/896 (calendar 338/338), browser 49/49; calendar build, standalone typecheck, root build, contracts and diff check GREEN; configured lint N/A. Four docs and breaking 0.8.0 manifest/lock reviewed; no peer changes required. T6 authorized and precommit review recorded below; this committed plan intentionally stops at prior-to-commit evidence. Actual commit/push/PR outcomes belong in the PR and execution report. Current user scope is T6 ONLY; T7/T8 are not authorized. Executor works directly, no nested agents; model labels below are template metadata only.

Plan only. User approved replacing exclusive Unaccepted shortcut with independent needsAction toggle. Copy this file to `plans/calendar-fix-independent-unaccepted.md` ONLY inside implementer's new worktree. No main-worktree edits. Applicable instructions: repository `CLAUDE.md`; references: calendar product-behavior §Package, README §RSVP filtering, design §Decisions, SPEC theme contract.

## Goal
Unanswered events visible iff Unaccepted (O) enabled, subject to existing calendar/window filters. Accepted, Maybe, Declined and O independently reflect and toggle their own selection membership.

## Scope
- `packages/calendar/src/react/CalendarPane.tsx`: remove exclusive/save-restore state; route every chip through existing membership toggle; pressed/style state from membership.
- `packages/calendar/src/react/styles.css` and, only if actual intersection measurement requires it, ribbon-specific logic in `packages/calendar/src/react/CalendarPane.tsx`: approved minimal visible-intersection centering repair.
- `packages/calendar/src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`: deterministic empty-Today regression and retained scroll/short-ribbon coverage.
- `packages/calendar/src/react/__tests__/CalendarPane.test.tsx`: regression coverage; replace only approved exclusive-shortcut expectations.
- `packages/calendar/src/react/__tests__/CalendarPane.theme.test.tsx` and `calendarTheme.browser.test.tsx`: retain theme/interaction coverage; update obsolete exclusive expectations and names.
- `packages/calendar/src/core/__tests__/events.test.ts`: lock membership/default visibility contract using real events.
- `packages/calendar/{product-behavior.md,design.md,README.md,SPEC.md}`: independent-toggle contract and current selection terminology.
- `packages/calendar/package.json`, root `package-lock.json`: breaking release metadata; peer updates only if required by release verification.
- Worktree-local `plans/calendar-fix-independent-unaccepted.md`: execution evidence/status.

## No Scope
- No filtering refactor, new public state/storage, migration, badge redesign, icon/layout changes beyond the approved ribbon centering repair, or controller/date/auth behavior changes.
- No main-worktree edits, local main merges, direct main pushes, unrelated dependency upgrades, baseline-fix commits or test removal to hide failures.
- No default selection change: retain accepted/tentative/needsAction; O must therefore appear pressed initially. User approved independent toggling, not a different default.

## Decisions (resolved)
1. Membership is truth: `selectedRsvpStatuses.has('needsAction')` controls O appearance and visibility. Mixed selections press O too.
2. Reuse existing `toggleRsvpStatus` helper for all four statuses. Toggle a cloned current set; no previous selection memory. Keep zero-selected fallback to existing defaults. Thus O-only -> O click falls back to defaults, where O stays pressed; document/test this exception to simple subtraction.
3. Host-controlled external changes render exactly their supplied membership. Explicit empty host selection remains empty; pane does not normalize props or emit callbacks on rerender.
4. Preserve badge count before RSVP filtering, zero/99+ handling and accessible full count. Preserve chip order, callback shape, theme behavior and calendar selection.
5. Breaking public behavior explicitly approved. Use breaking commit and next breaking 0.x minor release (current calendar 0.7.0 -> 0.8.0 if still current); recheck versions/tags at implementation time.
6. ANY unexpected command/test failure: halt feature progression, RCA, report failure and attempted diagnosis; no commit/push with unresolved failure. Expected TDD assertion red is deliberate evidence, not permission to ignore unrelated failures. This overrides planner-template early baseline commits/merges.

## Findings
- Confirmed repro supplied by user: Node strip-types import of core events; 69 core tests passed. Singleton accepted/tentative/declined correctly exclude pending. `filterByRsvp` (`core/events.ts:58`) already does exact membership; do not change it.
- `DEFAULT_RSVP_STATUSES` (`core/events.ts:5`) includes needsAction. Pending appears under defaults correctly, but UI misreports O as off.
- Pane `:214-219` stores selection and detects singleton exclusive mode; `:251-265` saves/restores and toggles other chips against saved state; `:461-465` special-cases pressed/style/click. Replace those special cases minimally.
- Data flow: controller selected-calendar/window snapshot -> pane `events` -> pre-filter pending badge (`:221`) and independent `filterByRsvp` (`:226`) -> groups/render. Host owns selected set and applies callback results. No controller plumbing needed.
- Pane tests around `:145-281` and helper `expectPressedSelection :167` encode exclusive behavior. Theme unit test `:88-107` and browser test `:501-516` also expect singleton pending and must change while preserving their original theme assertions.
- Other status/source/legacy tests use mixed needsAction selections intentionally. Audit, do not bulk rewrite these valid fixtures.
- Environment failure RCA completed before further planning: calendar manifest `:38` declares user-event ^14.6.8; lockfile `:1659` resolves 14.6.8 and workspace lock entry declares it. `npm ls @testing-library/user-event -w @open-webapp/calendar` returns empty; Node `import.meta.resolve` returns ERR_MODULE_NOT_FOUND. Root cause is missing installed declared dev dependency, not a broken test/API or missing declaration. Exact historical cause of incomplete install unknown. Repair installation only in worktree; prove resolution and baseline there.
- `npm test -w @open-webapp/calendar -- --run src/core/__tests__/events.test.ts src/react/__tests__/CalendarPane.test.tsx --no-cache` previously failed loading pane suite. Do not count this as green baseline.
- Root test script runs workspace tests; calendar has build/test/browser scripts but no lint/typecheck script. CI currently runs contracts, drive-sync build and drive-connect tests, so CI green alone is insufficient calendar validation.
- No schema-spec.md exists in calendar. SPEC.md is present; update only relevant contract text. No applicable nested AGENTS/CLAUDE instructions found. Existing untracked main files are unrelated user work.

## Dependency Graph
```text
T0 -> T1(installation/root baseline completed; browser blocker confirmed)
    -> T1a(ribbon regression red) -> T1b(minimal ribbon fix)
    -> T1c(remaining baseline gates) -> T2(red behavioral tests)
    -> T3(minimal toggle fix) -> T4(docs + release metadata)
    -> T5(full gates) -> T6(commit/push/PR) -> T7(checks/merge/tag) -> T8(cleanup)
```

## Tasks (each <=30 min)

### T0 - Make isolated worktree (<=15m, deps: none)
- model: haiku
- Inspect status/branches; fetch origin; create branch from current remote main: `git worktree add ../worktree-calendar-independent-unaccepted -b fix/calendar-independent-unaccepted origin/main`. Run subsequent commands with workdir set there.
- Copy this plan into worktree `plans/calendar-fix-independent-unaccepted.md`; reread applicable repo instructions there.
- Tests: verify `git worktree list`, branch base and main status. Edge: branch/path collision -> choose fresh name. Error -> halt/RCA.
- Accept: all writes and installs restricted to new worktree; main user files preserved.

### T1 - Installation and baseline gates (<=30m, deps: T0)
- model: haiku
- Use Node 24 as CI. Install lockfile dependencies including dev packages with `npm ci --include=dev --legacy-peer-deps` in worktree. Do not reuse incomplete main node_modules. Any failure -> halt/RCA; never regenerate lockfile blindly to bypass failure.
- Prove `npm ls @testing-library/user-event -w @open-webapp/calendar` resolves 14.6.8; confirm Node resolution and rerun exact previously failing targeted command.
- Run full `npm run test`, calendar browser suite `npm run test:theme-browser -w @open-webapp/calendar`, calendar build, available lint/typecheck scripts and `./scripts/check-contracts.sh`. Browser provisioning, if needed, only worktree/temp environment.
- Tests: suite loads and assertions run; dependency missing/error -> stop, report cause/evidence. No baseline code/test edits or early commit/merge.
- Accept: every baseline gate green with evidence in worktree plan; otherwise stop for direction. All feature tasks blocked on this.

### T1a - Deterministic empty-Today ribbon regression RED (<=30m, deps: T1 completed installation/root gate and approved ribbon RCA)
- model: sonnet
- Edit only `packages/calendar/src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`; record red evidence in `plans/calendar-fix-independent-unaccepted.md`. Work directly in `/home/mohan/owa/worktree-calendar-fix-independent-unaccepted` on `implement-calendar-fix-independent-unaccepted`; no nested agents.
- Set browser time explicitly with `vi.setSystemTime(new Date(2026, 9, 26, 12))` before mounting; restore real time in cleanup. Keep real timers for React/ResizeObserver/frame waits. Construct timed events on local Oct 27 using local Date components (serialize instants only as needed), not UTC date-key extraction. This guarantees empty local Today before the event day across browser timezones.
- Assert the setup itself: Today has no events/ribbon; following Oct 27 group has the tall event ribbon; two day headers exist. Keep geometry expectations based on actual ribbon/scroll/header bounds, independent of implementation CSS variables.
- Happy: parameterize scrollTop 0/100/250; after setting scrollTop, await the browser scroll/layout turn and assert actual scroll position, a nonempty visible intersection, and label-center error <2px. Preserve the existing tolerance and tall-ribbon assertion. Edge: retain short-ribbon full-ribbon centering and existing no-extra-header coverage by explicitly choosing local Oct 27 today for that case; do not replace the empty-Today case with it.
- Tests: `npm run test:theme-browser -w @open-webapp/calendar -- src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`. Run on unchanged product source: empty-Today scrollTop=0 must fail for geometric centering (approximately 14.49px under recorded environment); 100/250 and short-ribbon controls must retain their assertions. Error: setup/import/timer failures are not expected red; halt/RCA.
- Accept: reproducible regression red independent of wall clock; log failing assertion and measured bounds. No source fix, tolerance widening, header removal, timezone override, or clock-only resolution.

### T1b - Minimal actual-visible-intersection ribbon fix GREEN (<=30m, deps: T1a)
- model: sonnet
- Edit `packages/calendar/src/react/styles.css` at `.calendar-day-ribbon-window` (currently lines 229–235); only if needed, add narrowly scoped ribbon measurement/update logic in `packages/calendar/src/react/CalendarPane.tsx` near existing scroll/ResizeObserver handling and ribbon markup (currently lines 371–391, 502–511). No component extraction, shared-layout refactor, public props or RSVP changes.
- Fix the window's actual visible intersection: top = max(ribbon top, scroll viewport top + sticky chip/day-header stack); bottom = min(ribbon bottom, scroll viewport bottom). Center the label within that interval when visible, including normal-flow ribbon top below the sticky threshold. Current `min(100%, viewport-minus-one-header-stack)` alone cannot account for that offset; changing the 33px fallback alone is insufficient.
- Prefer the smallest working layout change. If CSS alone cannot represent the interval, measure actual relevant bounds locally, update on scroll, initial layout, resize and rendered day-group changes, and clean up observers/listeners. Keep geometry out of public/RSVP state; do not trigger measurement from its own changed window height. Reuse existing refs where appropriate without altering recentering behavior. Use actual header bounds if measurement is needed, rather than baking in the observed 31px.
- Tests: rerun T1a targeted browser command; scrollTop 0/100/250, short ribbon and no-extra-header controls all <2px. Verify after a host resize and a mounted theme change that centering still uses the current visible slice; add these assertions to the same browser file if measurement invalidation is introduced. Run `npm test -w @open-webapp/calendar -- --run src/react/__tests__/CalendarPane.ribbon.test.tsx src/react/__tests__/CalendarPane.stickyHeaders.test.tsx` and full `npm run test:theme-browser -w @open-webapp/calendar` (includes theme suite).
- Edge/error: empty groups retain headers but no ribbon; short ribbons center within their own bounds; offscreen/empty intersections do not produce negative heights or nonfinite styles. Preserve ribbon parity, aria-hidden labels, sticky headers, scroll/recentering, theme tokens and local-browser date rules. Unexpected failure -> halt/RCA.
- Accept: deterministic red turns green through product geometry repair; full browser suite green, including existing theme interactions. Diff limited to ribbon fix/tests and plan evidence; no commit/push until all later gates pass.

### T1c - Complete remaining baseline gates (<=30m, deps: T1b)
- model: haiku
- Worktree only. Keep Node 24 and installed dependencies; drive-sync artifact build and full root 878-test pass are already recorded. Do not repeat installation or provision main. Run calendar build `npm run build -w @open-webapp/calendar`, standalone `npx tsc --noEmit -p packages/calendar/tsconfig.json`, and `bash scripts/check-contracts.sh`; run other applicable configured checks discovered in T1, recording absent lint as N/A.
- Tests: T1b full calendar browser and targeted ribbon/sticky unit gates must be green; record all remaining commands/results in this plan. T5 still runs full root/package/final gates after O changes; previous root green alone does not validate the ribbon implementation.
- Error: any unexpected failing gate -> halt feature progression, RCA/report; do not weaken contracts, commit baseline separately, merge early, or touch original main.
- Accept: all T1 baseline obligations now satisfied with ribbon regression red/green evidence and remaining build/type/contracts gates green. Only then begin independent O work.

### T2 - First O-toggle task: failing behavioral regression tests (<=30m, deps: T1c)
- model: sonnet
- Edit core events test and pane test. First add controlled-host regression: four named RSVP fixtures, default membership -> pending visible AND O pressed; O click -> accepted/maybe retained, pending hidden, O unpressed; O again -> pending returns without removing other statuses.
- Test mixed accepted+needsAction: O starts pressed; O click yields accepted; accepted click from mixed yields needsAction. Repeat for tentative/declined to show independent membership.
- Test singleton accepted/tentative/declined hide pending; pending-only shows pending; toggling sole selected status uses existing default fallback. Core membership assertions use actual returned event IDs, not mirrored helper logic.
- Test host rerenders to mixed/only pending/empty selections; no stale saved state or unsolicited callbacks. Double-click round trip returns original selection. Original sets remain unchanged.
- Update exclusive-only assertions/helper in pane suite to approved semantics; keep badge, accessibility and unrelated contracts intact. Do not weaken tests to get green.
- Accept: new regressions fail on wrong pressed state and exclusive callback sets, not setup/import errors. Record red evidence; unexpected failure -> halt/RCA.

### T3 - Minimal toggle fix and integration assertions (<=30m, deps: T2)
- model: sonnet
- Edit CalendarPane.tsx: remove `savedSelection`, `isExclusive`, cleanup effect and `handleUnaccepted`; `handleToggle` uses current selected set with existing helper; every chip uses membership for class/aria and same click handler. Keep hooks/imports still used elsewhere.
- Update theme unit/browser tests to expect accepted+tentative+needsAction after O, retain mixed selection across theme transitions and return to original after O again. Rename memory-specific test descriptions; preserve focus/search/theme/callback assertions.
- Tests: targeted core/pane and theme suites; browser theme suite. Happy/edge cases from T2 green; badge zero/full count and no-event states unchanged. Error: any unexpected failure -> halt/RCA, no commit.
- Accept: no exclusive saved-state path; no change to defaults, membership filter or controller.

### T4 - Docs, breaking release and peer sweep (<=30m, deps: T3)
- model: haiku
- Read touched docs fully. Update product-behavior §Package RSVP and theme preservation; README props/defaults, RSVP, theme language and add breaking release note; design §Decisions and SPEC mounted-theme contract refer to current RSVP selection, not saved shortcut memory.
- Preserve historical release notes as historical; qualify or supersede old shortcut description with new breaking entry.
- Verify current calendar package/tag/published version; bump breaking minor (0.8.0 from researched 0.7.0). Update lockfile deliberately inside worktree.
- Inspect every packages/*/package.json peer on workspace packages; calendar currently peers only external react/vitest. Verify latest published versions for any workspace peers actually found; update dependent peer/dev ranges and release metadata only where required. No speculative dependency churn.
- Grep all calendar root docs and tests for `Unaccepted`, `exclusive`, `savedSelection`, `saved RSVP`, `needsAction`, `DEFAULT_RSVP_STATUSES`; inspect each match. No schema-spec exists: record N/A rather than fabricate it.
- Tests: docs match mixed/default/singleton behavior and fallback; metadata/lock agree; historical text clearly versioned. Error -> halt/RCA.
- Accept: no stale current-contract exclusivity claims; sweep recorded before commit.

### T5 - Full precommit verification (<=30m, deps: T4)
- model: sonnet
- Run full root `npm run test`; calendar full tests and browser tests; calendar `npm run build -w @open-webapp/calendar`; calendar `npx tsc --noEmit -p packages/calendar/tsconfig.json`; run any applicable configured lint/typecheck scripts discovered in worktree. No lint script presently exists: explicitly record N/A; do not invent a lint toolchain. Run root build where applicable and `./scripts/check-contracts.sh`.
- Run doc grep sweep again, `git diff --check`, inspect status/diff and acceptance cases. Confirm only intended package/tests/docs/lock/plan changed; generated artifacts untracked/ignored as appropriate.
- Tests: all functional, browser, type/build, contract and configured lint gates green. Any failure -> halt/RCA and report, no commit/push; no fixing by weakening tests.
- Accept: complete validation evidence; no unresolved failures.

### T6 - Commit, push, open PR (<=20m, deps: T5)
- model: sonnet
- Inspect `git status`, `git diff`, `git log --oneline -10`, tracking and base diff; review every included commit. Stage intended files only, no secrets/unrelated work.
- Commit breaking change e.g. `fix(calendar)!: make Unaccepted an independent RSVP toggle`, with BREAKING CHANGE explanation and genuine tool attribution if required; do not copy a false model identity from template.
- Push feature branch; `gh pr create --base main` with approved behavior, baseline RCA, validation and breaking version. Return PR URL in execution report.
- Tests: staged diff matches validated change; hook/push failure -> stop/RCA; never amend failed commit or bypass hooks.
- Accept: PR open against main. No release tag yet.

### T7 - Checks gate, GitHub merge, merged release tag (<=30m active effort, deps: T6)
- model: sonnet
- Poll `gh pr checks <pr>` every 30–60s until none pending. If checks fail, never report, or required checks skipped: no merge/tag; inspect `gh run view --log-failed`, report relevant logs and stop for direction. Do not bypass protections.
- All required checks green and all reported checks successful: `gh pr merge <pr> --merge`. Never merge main locally or push main directly.
- Fetch origin/main from isolated worktree; verify merged commit and release version. User forbids edits in original main: do not checkout/reset/pull there. Fetched origin/main is local updated main reference for verification; leave checked-out original main untouched.
- Tag exact GitHub merge commit `calendar-v<verified-version>` and push tag. Existing conflicting tag/publish failure -> halt/RCA, never move tag. Verify release workflow success; failure -> report, retain worktree.
- Tests: remote main contains merge commit; tag resolves to that commit; release workflow succeeds.
- Accept: GitHub merge and merged-release tag pushed, publish successful.

### T8 - Success-only cleanup (<=5m, deps: T7)
- model: haiku
- From original directory, remove isolated worktree and delete merged local branch only after success. Preserve execution evidence in merged plan/PR; never force-remove dirty work.
- Tests: worktree absent, remote main/tag correct, original main working files/status unchanged.
- Accept: cleanup complete only on successful release. Any blocker retains branch/worktree for diagnosis.

## Test Strategy
- Ribbon layout seam -> `packages/calendar/src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`: explicit local Oct 26 today / Oct 27 events, empty Today before tall event day, actual visible-intersection <2px at scrollTop 0/100/250; short-ribbon and same-day controls. No clock-only fix. Preserve theme browser and sticky/ribbon unit gates.
- Core membership seam -> events.test.ts; pane controlled-host behavioral seam -> CalendarPane.test.tsx; mounted interaction preservation -> CalendarPane.theme.test.tsx and calendarTheme.browser.test.tsx.
- Use real accepted/tentative/declined/needsAction fixtures; assert visible titles/IDs, pressed state and callback sets together. Cover defaults, mixed, singleton, empty external props, last-status fallback, host updates and double click.
- Existing badge/calendar/theme/error/date contracts stay covered. All baseline and final full gates mandatory; CI does not cover calendar adequately by itself.
- Expected TDD red allowed only for named new behavior assertions. Unexpected failure always halt/RCA; no unresolved failure committed.

## Acceptance
- Approved ribbon blocker repaired using actual visible intersection; deterministic empty-Today regression and scroll 100/250 controls pass without relaxing tolerance or changing local-date/grouping contracts.
- O pressed iff supplied selection contains needsAction, including defaults/mixed sets.
- Pending visible iff O pressed within existing selected calendars/window; accepted/maybe/declined memberships independently preserved.
- Four toggles share existing last-deselection fallback; props remain immutable; no saved selection restoration.
- Badge counts/accessibility/chip order and mounted theme interaction state preserved.
- Full tests/browser/lint-if-configured/typecheck/build/contracts and documentation sweep green before commit.
- Breaking version/commit, peer verification, PR green checks, GitHub merge and merge-commit release tag complete; main worktree untouched.

## Risks
- Default includes pending: preserve default, show O pressed. Removing needsAction from defaults would be an additional unapproved default change.
- Last-chip fallback includes needsAction: document/test O staying pressed on fallback rather than silently changing fallback contract.
- Incomplete dependency installation can masquerade as suite failure: clean dev install and resolution proof before feature work.
- Hidden exclusive assertions in theme suites/docs: targeted cross-file sweep plus browser run.
- CI lacks calendar suite: complete local gates required independently of PR checks.
- Main update instruction versus no-main-edits: fetch remote main and verify from isolated worktree; never mutate checked-out main. If branch movement of original main is demanded, stop for user direction.
- Slow CI/release may exceed task wall clock: <=30m active tasks; keep polling phase pending, never shortcut gate.

## Post-change docs
- Canonical calendar product-behavior §Package; design §Decisions; README RSVP, default prop, theme and breaking-release sections; SPEC theme preservation contract.
- No schema change or schema-spec creation. Worktree plan records RCA, expected red, green commands, grep sweep, peer/version evidence, PR/check/merge/tag outcome.

## T0/T1 execution evidence — halted baseline

### T0 remainder
- Used only `/home/mohan/owa/worktree-calendar-fix-independent-unaccepted`, branch `implement-calendar-fix-independent-unaccepted`; no new worktree or delegation.
- Read root `CLAUDE.md` in that worktree. Copied the supplied `/tmp/opencode/calendar-fix-independent-unaccepted.md` using `apply_patch`, then appended execution evidence here.
- Initial `git status --short` was empty. `git worktree list` confirmed original `/home/mohan/owa/owa` remains on `main`.
- `git merge-base HEAD main` and `git rev-parse main HEAD` all returned `581d517f6fd7d2551f43a1523b90fb6758a063b8`: branch is exactly at local main. No fetch or branch recreation needed under user's existing-branch instruction.
- All commands ran with workdir set to the isolated worktree. No original-main edits, checkout, reset, pull, install or test commands.

### T1 commands and results
1. `node --version`: `v24.19.0`; `npm --version`: `11.17.0`; Node path `/home/mohan/.nvm/versions/node/v24.19.0/bin/node`. Matches CI Node major 24.
2. `npm ci --include=dev --legacy-peer-deps`: PASS; 204 packages added, 210 audited. Reported 10 audit vulnerabilities and pending install-script approval warnings for esbuild/msw; installation exited successfully. No dependency/lockfile edits or remediation attempted.
3. `npm ls @testing-library/user-event -w @open-webapp/calendar`: PASS; direct `@testing-library/user-event@14.6.8`, also deduped under `@vitest/browser@2.1.9`.
4. `node --input-type=module -e "console.log(import.meta.resolve('@testing-library/user-event'))"`: PASS; resolved `file:///home/mohan/owa/worktree-calendar-fix-independent-unaccepted/node_modules/@testing-library/user-event/dist/esm/index.js`. Confirms prior missing-install environment issue repaired.
5. `npm test -w @open-webapp/calendar -- --run src/core/__tests__/events.test.ts src/react/__tests__/CalendarPane.test.tsx --no-cache`: PASS, 2 files / 173 tests (69 core + 104 pane). React act warnings emitted; no failed tests or import errors.
6. `npm run test`: FAIL. Workspace runner itself continued through calendar after sibling failures; no separate gates were started afterward.
   - drive-sync: 33 files / 292 tests passed.
   - drive-connect: `src/__tests__/auth.test.ts` and `src/__tests__/widget.test.tsx` failed suite loading; no tests ran.
   - project-sync: 4 files failed / 9 passed; 2 tests failed / 178 passed. Suite-load failures: `src/__tests__/documents.test.ts`, `integration-fakes.test.ts`, `status.test.ts`. Failed assertions/load paths in `smoke.test.ts`: `imports main entrypoint with type exports` and `type imports from index work correctly`.
   - calendar: 23 files / 320 tests passed within the same root invocation.
   - Full captured output: `/home/mohan/.local/share/opencode/tool-output/tool_17c01a7ad001zwqhLX9eZ493NX`.

### RCA and classification
- Key error: `Failed to resolve entry for package "@open-webapp/drive-sync". The package may have incorrect main/module/exports specified in its package.json.` Integration-fakes also reports `Failed to load url @open-webapp/drive-sync/testing ... Does the file exist?`.
- Root cause supported by read-only inspection: npm workspace link resolves to this worktree's `packages/drive-sync`; its manifest exports `./dist/index.js` and `./dist/testing/index.js`, and both files are absent (`existsSync` false; dist glob empty). Clean installation does not build this workspace package; root test script runs workspace tests without a build prerequisite.
- Classification: pre-existing clean-checkout build-artifact/setup prerequisite, not the prior user-event issue or a feature regression. No feature code changed. `git diff main -- packages package.json package-lock.json .github/workflows/ci.yml` is empty; `git show main:packages/drive-sync/package.json` confirms identical dist exports on main. `git show main:.github/workflows/ci.yml` confirms CI explicitly builds drive-sync before testing drive-connect (lines 22–23). Comparison was through git objects only; original main worktree untouched.
- Not classified as flaky: failures consistently share the statically absent exported artifacts; no flaky claim or reruns used. Did not build to repair baseline or change code after failure.

### Deferred gates / blocker
- HALTED per instruction. Calendar browser command `npm run test:theme-browser -w @open-webapp/calendar`, calendar build, standalone typecheck, and `bash scripts/check-contracts.sh` were not run after the root failure.
- Root and calendar manifests expose no lint/typecheck scripts; calendar standalone `npx tsc --noEmit -p packages/calendar/tsconfig.json` remains deferred. No lint tooling invented.
- T1 is not accepted; T2+ remain blocked. Await direction on provisioning the missing drive-sync build artifacts and rerunning the failed root gate before remaining baseline gates.
- No source/test/manifest/lockfile edits, commits, pushes or implementation. Only this plan is untracked; installed dependencies are worktree-local.

## T1 continuation — approved artifact provisioning; halted browser baseline

- Executed directly in the same worktree; no delegation. Reread repository instructions and this plan. Node remains v24.19.0.
- Reconfirmed reported RCA before repair: `packages/drive-sync/dist/index.js` and `dist/testing/index.js` both absent; `git diff main -- packages package.json package-lock.json .github/workflows/ci.yml` empty. Manifest exports target those files; CI lines 22–23 build drive-sync before drive-connect tests.
- Approved remedy: `npm run build -w @open-webapp/drive-sync` PASS (`tsc`). drive-sync has no workspace dependency to build first; dependent test consumers need only its artifacts. No tracked source changes.
- `npm run test`: PASS, 71 files / 878 tests: drive-sync 33/292, drive-connect 2/35, project-sync 13/231, calendar 23/320. Prior export-resolution failures are gone. Existing React act warnings and deliberate error-path stderr emitted without failures. Full output: `/home/mohan/.local/share/opencode/tool-output/tool_17c052531001XvK2RBtXF4ov5f`.
- `npm run test:theme-browser -w @open-webapp/calendar`: FAIL, 44 passed / 1 failed across 2 files. `calendarTheme.browser.test.tsx` passed all 41; ribbon suite passed 3/4. Failure: `CalendarPane.ribbon.browser.test.tsx:48`, `centers the date label in the visible part of the ribbon (scrollTop=0)`: `expected 14.4921875 to be less than 2`.
- Immediately halted remaining gates. Diagnostic-only rerun: `npm run test:theme-browser -w @open-webapp/calendar -- src/react/__tests__/CalendarPane.ribbon.browser.test.tsx` reproduced exactly the same 14.4921875px mismatch, 3 passed / 1 failed. Not classified as flaky or as cross-file interference.
- Read-only main comparison: `git diff main -- packages/calendar` empty; HEAD and main both `581d517f6fd7d2551f43a1523b90fb6758a063b8`. This reproduces on unchanged main code in this worktree, without touching the original main checkout.
- RCA scope: reproducible pre-existing browser layout/assertion mismatch, not missing package artifacts or feature regression. Test mounts a 360x400 host, waits 100ms, then compares label center against the visible ribbon slice below measured sticky headers. CSS `.calendar-day-ribbon-window` uses sticky positioning and a height calculated from scroll/header variables (`styles.css:229–235`). Exact underlying geometry cause is not yet established; no assertion or CSS changes made.
- Proposed next action (requires direction): read-only browser geometry instrumentation in a temporary diagnostic harness to capture actual scroll/header/ribbon/window/label bounds and computed CSS variables at scrollTop=0, determine whether CSS positioning or the expected-visible-slice calculation is wrong, then report a separately scoped remedy. Do not weaken tolerance or bypass the failing test.
- Calendar build, standalone typecheck (`npx tsc --noEmit -p packages/calendar/tsconfig.json`) and `bash scripts/check-contracts.sh` remain unrun due to mandatory halt. Root/calendar scripts have no configured lint/typecheck commands; lint N/A. T1 remains unaccepted, T2+ blocked.
- Final status: only this plan untracked; tracked diff empty. Worktree preserved; no feature edits, commits, pushes, or original-main changes.

## Ribbon baseline RCA — research only

- **Failure:** `CalendarPane.ribbon.browser.test.tsx:48`, `centers the date label in the visible part of the ribbon (scrollTop=0)`; `expected 14.4921875 to be less than 2`. Original browser baseline 44 pass / 1 fail; targeted repeat and instrumented real-clock runs each 3 pass / 1 fail with the identical error.
- **Method:** external `/tmp/opencode/ribbon-rca.config.mjs` Vite pre-transform logs DOM bounds/computed CSS without editing repository source/tests. Cache is under `/tmp/opencode`; subsequent runs disable Vitest result caching. Original assertions remain intact. Targeted command: `./node_modules/.bin/vitest run --config /tmp/opencode/ribbon-rca.config.mjs src/react/__tests__/CalendarPane.ribbon.browser.test.tsx` from this worktree.
- **Confirmed trigger:** test uses fixed Oct 27, 2026 events but does not freeze the clock. Browser renders `Today · Oct 26` (empty group), then `Tomorrow · Oct 27`. `CalendarPane.tsx:205,266` derives local today and passes it to `groupByDay`; `core/events.ts:135–153` intentionally synthesizes an empty today group. Thus this fixture has two 31px headers, not one. This is date-sensitive setup exposing a genuine layout limitation, not a timing flake or missing dependency.
- **Exact geometry at scrollTop=0:** scroll viewport [0,400]; chips [0,56]; empty today header [56,87]; event-day header [87,118]; ribbon [118,850]. Expected visible ribbon center is `(118+400)/2 = 259`. CSS `styles.css:229–235` uses sticky top `56+33=89` and fixed window height `400-56-33=311`. Because normal-flow ribbon top 118 is below sticky top 89, the window stays at 118 and ends at 429, outside the viewport. Label center is 273.4921875, yielding exactly 14.4921875px error (29px overflow / 2, with subpixel text rounding). `height:min(100%,...)` caps against ribbon height, not the currently visible ribbon slice.
- **Why other cases pass:** at scrollTop 100/250 the window sticks at 89 and ends at 400; label center 244.4921875 vs expected 243.5 (0.9921875px). Actual day header is 31px while CSS fallback is 33px (`--calendar-day-header-height` unset); this contributes the residual ~1px, not the 14.49px primary failure. Fonts are loaded, devicePixelRatio=1, measured scroll/chip variables are already 400px/56px; no evidence of delayed ResizeObserver/font setup. The helper selects the first header, but headers have equal heights here, so that does not explain this failure.
- **Main evidence:** HEAD and main remain `581d517f6fd7d2551f43a1523b90fb6758a063b8`; `git diff main -- packages/calendar` empty. Attempting a direct main-root run with the external runner encountered main's incomplete/mismatched browser dependencies (`@testing-library/user-event` unresolved, then `__vitest_browser_runner__.runTests is not a function`); an alias experiment failed resolving virtual `@vitest/browser/client` and timed out. Neither attempt ran assertions; neither is evidence of a product failure. To avoid installing/writing main, `RCA_MAIN_SOURCE=1` makes the temporary loader read actual main-checkout calendar source/test/CSS files while retaining worktree dependency resolution and temporary caches. This run reproduces the exact 14.4921875px failure (3 pass / 1 fail). This is a main-source comparison with shared dependencies, not a successful independent main-install baseline.
- **Controlled clock evidence:** `RCA_MAIN_SOURCE=1 RCA_CLOCK=1` with the same targeted command temporarily sets browser Date to `2026-10-27T12:00:00Z` using `vi.setSystemTime` in the in-memory transform only. All 4 tests pass. One header remains, ribbon top becomes 87, sticky window is [89,400], error 0.9921875px. No fixture/assertion/CSS file edits. This confirms the wall-clock-dependent extra header as the trigger.
- **Classification:** confirmed pre-existing, date/environment-triggered CSS geometry defect plus an unfrozen-date test assumption; not an independent-Unaccepted feature regression. A clock freeze alone makes this test deterministic but would hide the demonstrated multi-header layout defect if used as the sole resolution.
- **Proposed minimal action (approval required):** separately authorize a targeted ribbon-layout fix so the centering window uses the actual visible intersection (including normal-flow ribbon top), with coverage for an empty today group before the event day. Also stabilize the existing fixture's local date explicitly if approved; preserve the 2px assertion. Do not remove the intentional empty today group or change RSVP behavior. Exact implementation remains to be designed under that separate scope; no repair applied during RCA.
- **Disposition:** T1 remains blocked; controlled-clock diagnostic green does not replace the failing real-clock baseline. No feature work, tracked source/test edits, commits or pushes. Only this existing untracked plan updated; preserve this worktree.

## Approved ribbon planning follow-up — no implementation

- User approved expanding scope to the minimal ribbon repair; T1a/T1b/T1c now precede independent O work. Previous approval-required/proposed-disposition notes above are historical evidence, superseded by this approval.
- Targeted source confirmation: `styles.css:229–235` sets sticky top to chips + one header and height to min(ribbon height, viewport minus that stack). `CalendarPane.tsx:371–391` measures only scroll height/chip height, not normal-flow ribbon offset or actual day-header height; `:502–511` renders a ribbon only for nonempty groups. `core/events.ts:135–153` intentionally inserts empty today. Together these explain the measured [118,429] window overflowing a [0,400] viewport; expected center 259 versus actual 273.4921875.
- Executor instruction: use this existing worktree/branch directly; no nested agents, source refactors, early baseline commit/merge or original-main edits. This planning pass changed only this plan; no tests run or source implementation performed.

## T1a execution — HALTED on unexpected fixture/grouping failure

- Worked directly on `implement-calendar-fix-independent-unaccepted` in the specified worktree; read repo instructions, current plan and current ribbon browser test before edits. No delegation. Edited only the ribbon browser test and this plan using `apply_patch`; product source remains unchanged. No commit.
- Test changes: explicit local Oct 26 noon clock for empty-Today cases, local Oct 27 timed event construction, real-timer cleanup, setup assertions for empty Today plus the event group, and geometry checks at scrollTop 0/100/250 after a real layout wait. Kept tall-ribbon and <2px assertions; added bounds evidence to the geometry assertion. Retained short-ribbon full-ribbon centering and explicit local Oct 27 same-day/no-extra-header controls (also 0/100/250).
- Ran exactly `npm run test:theme-browser -w @open-webapp/calendar -- src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`: exit 1; **6 failed / 1 passed**, one file. Duration 4.11s. Short-ribbon test passed.
- Unexpected failing names: `centers the date label after empty Today (scrollTop=0)`, `(scrollTop=100)`, `(scrollTop=250)` each fail at test line 67: expected two `.calendar-day-header` elements, received three. `centers the date label without an extra day header (scrollTop=0)`, `(scrollTop=100)`, `(scrollTop=250)` each fail at line 82: expected one header, received two.
- **No intended geometric RED established in this execution.** Setup assertions fail before bounds measurement; no actual ribbon/label bounds were captured, and prior historical 14.4921875px evidence above is not a result of this edited test run.
- Read-only RCA: `core/events.ts:112–115` groups timed events using `start.dateTime.slice(0, 10)`, not the local date of the parsed instant. The new fixture builds local Oct 27 hours 08–19, then uses `toISOString()` to serialize instants; this can cross the UTC date boundary and create an extra event-day group. Environment check via Node reports `America/Los_Angeles`, first instant `2026-10-27T15:00:00.000Z`, last `2026-10-28T02:00:00.000Z`, consistent with the observed extra header in both scenarios. Browser config specifies no timezone override. This is an unexpected fixture/serialized-date-grouping interaction, not geometric regression evidence or a timer/import failure.
- Per mandatory halt rule, no fixture correction, product fix, tolerance change or test rerun after this failure. T1a remains incomplete; T1b and later work blocked. A follow-up needs direction to repair fixture serialization while preserving local Oct 27 instants and the required single event-day setup, then rerun the exact targeted command. Do not change public grouping behavior as part of T1a.

## T1a continuation — approved setup repair; intended RED established

- User authorized earlier local Oct 27 event times only, preserving duration/tall ribbon, group assertions, geometry tolerance and controls. The previous halt above is historical; this continuation completes T1a only.
- Setup RCA/resolution: previous local 08:00–19:30 fixture serialized across UTC midnight under existing string-prefix grouping. Changed starts to local 04:00–15:00, keeping all 12 half-hour events. Actual browser diagnostic confirms `America/Los_Angeles`, first start `2026-10-27T11:00:00.000Z`, last end `2026-10-27T22:30:00.000Z`. Both endpoints and intervening events remain on Oct 27; no timezone override or product grouping change. Ribbon height remains 732px (>300px).
- Retained empty-Today assertions (two groups/headers, no Today events/ribbon, 12 events on Tomorrow Oct 27). Added explicit one-group/one-ribbon/12-event assertions to all same-day controls. Retained real timers, clock cleanup, actual scroll-position checks, nonempty visible intersection, <2px geometry tolerance and short-ribbon control. Added browser timezone/serialization evidence to test logs.
- Ran `npm run test:theme-browser -w @open-webapp/calendar -- src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`: exit 1, **1 expected failure / 6 passed**, one file, duration 3.12s. All setup assertions passed. Only failure: `centers the date label after empty Today (scrollTop=0)` at `expectVisibleCenter` line 61, `expected 14.4921875 to be less than 2`. No unexpected failures.
- Actual RED vertical bounds (px): scroll [0,400]; chips [0,56]; headers [56,87] and [87,118]; ribbon [118,850], height 732; window [118,429], height 311; label [250.671875,296.3125], center 273.4921875. Visible slice [118,400], center 259; absolute error **14.4921875px**. Window overflows the viewport by 29px, reproducing the intended normal-flow-offset defect.
- Green controls: empty-Today scrollTop 100/250 and same-day scrollTop 0/100/250 each measured visible center 243.5 vs label center 244.4921875, error **0.9921875px** (<2px); actual requested scroll positions confirmed. Short-ribbon full-ribbon centering passed too.
- T1a accepted; stopped here as requested. Product source/CSS unchanged; no T1b implementation, commits or pushes. Changes confined to this worktree's browser test and plan.

## T1b execution — browser GREEN; HALTED at sticky-header unit gate

- Worked directly in the specified worktree; read current instructions, plan, source, CSS and browser tests. Preserved all T1a assertions and fixtures. No delegation or commits.
- Product diff: ribbon becomes a relative positioning container; its window becomes absolute, with ribbon-local CSS properties for measured top/height. Added one scoped effect after the existing chip/scroll measurement effect. It measures viewport, chips, each ribbon and its own preceding day header; top = max(ribbon top, viewport top, chips bottom, actual header bottom), bottom = min(ribbon bottom, viewport bottom). Height is clamped to >=0; offset is clamped within the ribbon. No hardcoded header height. Uses no React/public geometry state.
- Invalidation/cleanup: initial effect measurement, passive scroll listener, ResizeObserver on scroll viewport/chips/day headers/ribbons, effect renewal on connected/reauth/filter content/local today/theme changes. Disconnects observer and removes listener. Window is absolute and not observed, avoiding window-height measurement feedback. Existing recentering and chip measurement code retained.
- Browser test diff beyond T1a: mount returns stable props and accepts explicit light/dark theme; one new mounted resize/theme test checks 400px -> 320px host resize, then dark theme and scroll 100 with unchanged <2px geometry assertion. Existing short-ribbon rerender also exercises rendered-content replacement.
- `npm run test:theme-browser -w @open-webapp/calendar -- src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`: PASS, 1 file / 8 tests, duration 4.27s. Empty-Today scroll0 now window [118,400], height282, label center258.9921875 vs visible center259: error **0.0078125px**, down from T1a **14.4921875px**. Empty-Today 100/250 and same-day 0/100/250 all error0.0078125px. Short ribbon passes. Resize uses window [118,320], center218.9921875 vs219; mounted dark remains centered; resized dark scroll100 center203.4921875 vs203.5.
- `npm test -w @open-webapp/calendar -- --run src/react/__tests__/CalendarPane.ribbon.test.tsx src/react/__tests__/CalendarPane.stickyHeaders.test.tsx`: FAIL, 1 file passed / 1 failed, **11 passed / 3 failed**, duration3.24s. Ribbon tests all8 pass; sticky CSS tests3 pass. Failed sticky measurement assertions at lines96/119/141: pane `--chip-row-height` received empty string, expected87px/56px/56px.
- **Read-only RCA:** sticky test ResizeObserver stub (`CalendarPane.stickyHeaders.test.tsx:54–59`) saves each constructor callback into one shared `resizeCallback`, overwriting previous callbacks. Existing chip observer is constructed first; new ribbon observer is constructed last. Tests invoke only that last callback with synthetic chip entries. Ribbon callback reads real bounds and does not write pane `--chip-row-height`; original chip callback never receives the test entries. This is a deterministic new-observer/test-harness interaction introduced by this implementation, not evidence that actual browser chip observation failed. No assertion changes or fixes made after failure.
- Mandatory HALT honored: full `npm run test:theme-browser -w @open-webapp/calendar` not run after unit failure; no further implementation, rerun, commit or push. T1b **not accepted**. Requires continuation direction to resolve observer integration (prefer reusing the existing observer while preserving chip border-box/fallback assertions), then rerun targeted browser and ribbon/sticky unit gates and full browser suite. T1c and later tasks remain pending.

## T1b continuation — approved observer integration; all T1b gates GREEN

- Worked directly in the existing worktree, without delegation. User approved reusing the existing ResizeObserver; no RSVP changes or test edits in this continuation.
- **Baseline evidence without repository edits:** temporary `/tmp/opencode/calendar-sticky-main.config.mjs` imports the worktree's unit configuration and uses a Vite pre-load hook to read `main:packages/calendar/src/react/CalendarPane.tsx` and `main:packages/calendar/src/react/__tests__/CalendarPane.stickyHeaders.test.tsx` through `git show`. Dependencies and remaining harness stay worktree-local; original main checkout is untouched. Main resolves to `581d517f6fd7d2551f43a1523b90fb6758a063b8`. Command `./node_modules/.bin/vitest run --config /tmp/opencode/calendar-sticky-main.config.mjs src/react/__tests__/CalendarPane.stickyHeaders.test.tsx`: PASS, 1 file / 6 tests, 2.19s. CSS contract assertions read current worktree CSS; the three relevant measurement tests run actual main component/test source. This is a main-source baseline with shared installed dependencies, not an independent main-install run.
- **Classification:** regression introduced by the first ribbon fix's separate observer integration, not pre-existing sticky behavior. Evidence: all six main-source sticky tests pass; prior first-fix gate had the three unchanged measurement assertions fail (empty property instead of 87px/56px/56px); source inspection shows the second observer overwrites the stub's sole retained callback. Browser geometry passing alone did not satisfy this integration contract. Tests were not weakened or rewritten.
- **Resolution:** merged ribbon geometry into the existing chip/scroll measurement effect and observer. Callback first handles scroll entries and chip entries by explicit target identity, then updates ribbon windows. Chip sizing retains `borderBoxSize?.[0]?.blockSize` and `getBoundingClientRect().height` fallback; header/ribbon entries cannot overwrite chip height. One observer watches scroll/chips/headers/ribbons, with initial measurement and passive scroll updates. Cleanup disconnects that observer and removes the listener. Existing content/date/theme invalidation, actual-header-bound intersection math, clamping and absolute-window CSS remain intact. Absolute windows are not observed, avoiding geometry feedback.
- `npm test -w @open-webapp/calendar -- --run src/react/__tests__/CalendarPane.ribbon.test.tsx src/react/__tests__/CalendarPane.stickyHeaders.test.tsx`: PASS, 2 files / **14 tests** (8 ribbon, 6 sticky), 2.80s. Original 87px/56px/56px assertions pass unchanged.
- `npm run test:theme-browser -w @open-webapp/calendar -- src/react/__tests__/CalendarPane.ribbon.browser.test.tsx`: PASS, 1 file / **8 tests**, 3.98s. Empty-Today and same-day scroll 0/100/250 controls, short ribbon, host resize and mounted theme change all pass the original <2px tolerance. Empty-Today scroll0 label center258.9921875 vs visible259; resized center218.9921875 vs219; resized dark scroll100 center203.4921875 vs203.5: error **0.0078125px**.
- `npm run test:theme-browser -w @open-webapp/calendar`: PASS, 2 files / **49 tests** (8 ribbon + 41 theme), 15.36s. Existing React act warnings emitted in theme tests; no failures or skipped tests.
- `git diff --check`: PASS. Current tracked diff: CalendarPane.tsx + shared observer/geometry integration; styles.css + relative ribbon/absolute measured window; existing browser-test diff + deterministic fixtures, geometry and resize/theme coverage. Tracked total **113 insertions / 28 deletions across 3 files**, plus this untracked execution plan. Sticky/ribbon unit tests unchanged.
- **Disposition:** T1b accepted; stopped at approved boundary. T1c build/type/contracts and later feature tasks remain pending. No commits or pushes.

## T1c execution — remaining baseline gates GREEN

- Executed directly in `/home/mohan/owa/worktree-calendar-fix-independent-unaccepted`; reread repository instructions and T1c task. No delegation. `node --version`: **v24.19.0**. Used existing installed dependencies and drive-sync artifacts.
- `npm run build -w @open-webapp/calendar`: **PASS**, exit 0 (`tsc && cp src/react/styles.css dist/styles.css`).
- `npx tsc --noEmit -p packages/calendar/tsconfig.json`: **PASS**, exit 0, no diagnostics.
- `bash scripts/check-contracts.sh`: **PASS**, exit 0, `contracts OK`.
- Configured-check audit: root/calendar scripts and workspace manifests expose build/test/browser commands, but no lint/typecheck/check scripts. **Lint: N/A**; standalone calendar typecheck executed above. CI configures contracts, drive-sync build and drive-connect tests, already covered by this gate and recorded baseline evidence. No additional applicable configured check remains for T1c.
- `git diff --check`: **PASS** before recording these results.
- Retained prior evidence without rerunning: full root **878/878**, unchanged ribbon/sticky units **14/14**, full calendar browser **49/49** (including targeted ribbon **8/8**). These results have their original scope: root predates the ribbon implementation; T5 must rerun full final gates after the O changes.
- **Disposition:** T1c accepted; remaining T1 baseline obligations satisfied. No unexpected failures. Stopped at T1c boundary; T2+ not started. Only execution plan updated in this task; no feature/source/test/dependency changes, commits or pushes.

## T2 execution — intended RSVP regression RED

- Executed directly in the existing worktree, no delegation. Read current plan, instructions, core/pane tests and current pane RSVP implementation before edits. Existing CalendarPane.tsx ribbon/shared-observer diff, CSS and ribbon browser tests were preserved; no product edits in T2.
- Changed only `src/core/__tests__/events.test.ts`, `src/react/__tests__/CalendarPane.test.tsx` (paths relative to packages/calendar) and this plan. Core adds default/mixed membership assertions on returned real event IDs and immutability. Pane controlled host now has four named RSVP invitations; adds defaults/visibility, independent mixed toggles, singleton visibility, four last-selection fallbacks, host mixed/pending/empty rerenders, callback counts and original-set immutability. Retains quick double-click round-trip test. Replaced only approved exclusive shortcut expectations/helper; badge, accessibility counts, order and unrelated assertions retained.
- Command: `npm test -w @open-webapp/calendar -- --run src/core/__tests__/events.test.ts src/react/__tests__/CalendarPane.test.tsx --no-cache`. Exit **1**, duration **5.09s**; **177 passed / 14 failed (191)** across two files. Core **73/73 passed**; pane **104 passed / 14 failed (118)**. Suites loaded and ran normally. Existing React act warnings emitted; no unexpected setup/import/unrelated test failure.
- Expected RED names under `CalendarPane > Unaccepted chip`:
  - `defaults show pending with O pressed`: visible invitation assertions passed; O aria-pressed false, expected true.
  - `default O click hides only pending and the next click restores it`: callback `{needsAction}`, expected `{accepted,tentative}`.
  - `host rerenders mixed, pending-only and empty selections without callbacks or mutation`: first mixed rerender visibility and no-callback assertions pass; O false, expected true.
  - `adds needsAction without removing accepted or maybe in a controlled host`: callback `{needsAction}`, expected defaults.
  - `returns to the original membership on a second Unaccepted click without mutating it`: first callback `{needsAction}`, expected defaults.
  - `toggles Accepted against current membership while keeping pending selected`: callback `{tentative}`, expected `{tentative,needsAction}`.
  - `uses defaults when toggling the sole accepted selection`, `... sole tentative selection`, `... sole declined selection`, `... sole needsAction selection` (4): correct default fallback callbacks pass; O false after fallback, expected true.
  - `uses the fresh host selection after an external change`: callback `{needsAction}`, expected `{accepted,needsAction}`.
  - `removes only pending from mixed accepted membership and restores it`, `... mixed tentative membership ...`, `... mixed declined membership ...` (3): initial O false, expected true.
- Classification matches unchanged old code: `isExclusive` presses O only for singleton pending; `handleUnaccepted` emits pending-only and saves/restores; `handleToggle` uses saved membership when exclusive. Core exact-membership behavior remains GREEN. All failures are approved new O pressed/callback expectations; no unexpected failure requiring halt/RCA.
- Passing controls include all four singleton visibility cases, all three ordinary-status removals from mixed membership (leaving only pending), ordinary Accepted toggle and quick double-click round trip, plus unrelated pane assertions. Assertions after each test's first RED (including later host rerenders/restoration checks) remain specified but are not claimed executed/passing.
- `git diff --check`: PASS. T2 test diff **129 insertions / 24 deletions**, plus plan evidence. Earlier ribbon changes remain separate pre-existing work. **T2 accepted as RED; stopped before T3. No product fix, commit, push or original-main changes.**

## T3 execution — minimal independent toggle GREEN

- Executed directly in the existing worktree; no delegation. Read CURRENT CalendarPane.tsx and preserved its prior ribbon geometry/shared ResizeObserver implementation in place. No file replacement from main. T2 core/pane tests, CSS and ribbon browser test were retained unchanged.
- Removed only the exclusive RSVP state (`savedSelection`, `isExclusive`), its cleanup effect and `handleUnaccepted`. `handleToggle` passes current supplied membership to existing cloning/fallback helper. All four chips derive selected class/aria-pressed from membership and use the same handler. Defaults, last-deselection fallback, pre-filter badge, filter/controller and ribbon behavior retained.
- Updated theme unit/browser obsolete singleton callback expectations to accepted+tentative+needsAction and renamed memory-specific descriptions. Added explicit Accepted/Maybe pressed assertions through mounted theme transitions; retained all original focus/search/theme/callback and second-O original-selection assertions.
- `npm test -w @open-webapp/calendar -- --run src/core/__tests__/events.test.ts src/react/__tests__/CalendarPane.test.tsx src/react/__tests__/CalendarPane.theme.test.tsx --no-cache`: **PASS**, 3 files / **198 tests** (core 73, pane 118, theme 7), 5.91s. All 14 expected T2 RED assertions now GREEN, including subsequent controlled-host/fallback/immutability assertions.
- `npm run test:theme-browser -w @open-webapp/calendar`: **PASS**, 2 files / **49 tests** (theme 41, ribbon 8), 16.04s. Existing geometry/resize/mounted-theme controls retain <2px tolerance; measured ribbon center error remains 0.0078125px. Both OS theme interaction cases pass.
- Existing React act warnings emitted in unit/browser runs; no unexpected failures, skipped tests or RCA blocker. `git diff --check`: **PASS**. Inspected combined source/theme diff: observer/geometry hunk remains the prior implementation; T3 source edits confined to RSVP state/handler/chip membership.
- **T3 accepted; stopped at requested boundary.** T4 docs/release and T5 full final gates remain pending. No commit, push, dependency/metadata edits or original-main changes.

## T4 execution — HALTED on unavailable sweep executable

- Worked directly in the specified worktree/branch, without delegation. Read repository instructions, all four calendar root docs fully, the complete current plan and root manifest. Existing T3 source/test changes preserved. T4 is incomplete; the status section's earlier T3-only scope is historical and superseded by the user's T4-only request.
- Release verification succeeded: calendar manifest **0.7.0**; local highest calendar tag **calendar-v0.7.0**; `git ls-remote --tags origin 'calendar-v*'` confirms highest remote tag **calendar-v0.7.0**, commit **581d517f6fd7d2551f43a1523b90fb6758a063b8**. `npm view @open-webapp/calendar version dist-tags --json` returns version/latest **0.7.0**. Therefore the approved next breaking pre-1.0 minor is **0.8.0**, but no version/lock edit has been applied.
- Inspected all four `packages/*/package.json` manifests. Calendar peers only external React `^19` and optional Vitest `^2.1.0`; drive-sync has no peers. Only workspace peer target found is drive-sync: drive-connect peer `^0.11.0 || ^0.12.0`, dev `^0.12.0`; project-sync peer/dev `^0.12.0`. Workspace drive-sync **0.12.0** matches `npm view @open-webapp/drive-sync version --json` **0.12.0**; all those ranges cover latest. No dependent declares a calendar peer. No peer/dependency updates required and no unrelated upgrades made.
- Unexpected command failure: repository-wide broad sweep using `rg -n -i 'unaccepted|exclusive|saved.{0,40}(selection|rsvp)|restor.{0,40}(selection|rsvp)|savedSelection|isExclusive|handleUnaccepted|needsAction|DEFAULT_RSVP_STATUSES' --glob '!package-lock.json' --glob '!plans/calendar-fix-independent-unaccepted.md' .` exited **127**, `zsh:1: command not found: rg`. It did not search any files; no sweep coverage is claimed.
- Read-only RCA: `command -v rg; command -v git; command -v node` reports no rg executable, while git resolves `/usr/bin/git` and Node resolves `/home/mohan/.nvm/versions/node/v24.19.0/bin/node`. Cause: unavailable ripgrep executable in this shell environment, not a test/product failure. No installation or replacement sweep attempted after failure, honoring mandatory halt.
- Doc read findings awaiting edits: current exclusivity claims in product-behavior RSVP bullets and README RSVP section; saved RSVP terminology in all four docs' mounted-theme contracts; historical README 0.3.0 shortcut note needs explicit supersession; README/SPEC stale header-height tuning description must reflect measured visible-intersection geometry. Historical plan notes remain historical. Broader doc/test audit remains pending.
- **HALTED; no commit/push.** Only this execution record changed during T4. Four product docs, calendar manifest and root lock remain unmodified. No T5 gates run; retained T3 evidence is targeted **198/198**, browser **49/49**, not a T4 verification result. Resume requires direction to use the available dedicated search tool (or git grep) for the broad sweep, then complete docs/metadata and T4 checks.

## T4 continuation — docs/version/sweep complete

- User approved the missing-rg tooling RCA and immediate available equivalent. Executed directly in the existing worktree, no delegation. Read CURRENT four docs fully, manifest, relevant lock/source and execution plan. Prior halted status is historical and superseded here.
- Updated README, SPEC, design and product-behavior: all four toggles use membership; O is default-on and pressed in mixed sets; unanswered visibility follows membership within calendar/window filters; other statuses are preserved; last-status fallback includes O-only -> defaults with O pressed; explicit empty host sets/rerenders are not normalized or callback-producing. Mounted-theme text now says current RSVP selection, not saved shortcut memory.
- README adds breaking 0.8.0 migration/release notes and explicitly supersedes historical 0.3.0 shortcut text. Four docs describe measured actual ribbon/viewport intersection below chips and the relevant header, short/empty-Today cases and scroll/resize/content/theme invalidation. Removed current fixed header-height tuning claim.
- Used prior verified manifest/npm/local+remote tag 0.7.0 evidence above to bump calendar to **0.8.0**. Applied only manifest version and root lock packages/calendar.version with apply_patch. Prior peer sweep remains applicable: no calendar workspace peers/consumers require changes; drive-sync peers cover published 0.12.0. No dependency changes.
- Two initial apply_patch attempts were rejected by context verification because hunks were ordered incorrectly; read-only diff confirmed no partial doc edits after the first rejection. Reordered/split patches succeeded. This was patch construction, not a product/test validation failure.
- Broad `git grep -n -i -E` sweep covered Unaccepted/exclusive/saved or restored selection/RSVP, savedSelection/isExclusive/handleUnaccepted, needsAction and DEFAULT_RSVP_STATUSES across tracked repository content (excluding lock and plans), then tracked plans separately. Inspected every match: current docs corrected; remaining exclusive references are explicitly historical/superseded, event end-boundary or unrelated API/token-envelope exclusivity. Calendar-selection persistence wording is valid and distinct from RSVP memory. Existing core singleton tests, mixed fixtures in legacy/source/status suites, badge/filter/theme tests, RSVP types and CSS are valid. Double-click/round-trip test descriptions describe observable membership restoration, not hidden saved state; retained them. No stale implementation identifiers remain. The untracked current plan was read directly; its historical evidence is intentionally retained. No schema-spec exists (N/A).
- `git diff --check`: **PASS**. Node JSON/assert validation: **PASS**, manifest and lock both 0.8.0; deep comparison with HEAD lock after changing only expected calendar version proves every other lock field unchanged. Final targeted stale-contract/header-variable sweep inspected; no current exclusivity/saved-memory claim remains. Diff/status limited to prior approved source/tests plus four docs, manifest, root lock and this plan.
- **T4 accepted.** No actual validation failure. T5 full final tests/build/type/contracts remain pending; prior T3 198/198 and browser 49/49 results are retained evidence, not newly run T4 tests. No commit, push, PR, tag or original-main changes.

## T5 execution — full precommit verification GREEN

- Executed T5 only, directly in `/home/mohan/owa/worktree-calendar-fix-independent-unaccepted`, with no nested agents. Read applicable instructions, complete plan/history and current diff. Node **v24.19.0**. Only this execution plan was edited during T5.
- `npm run test`: **PASS**, exit 0, **71 files / 896 tests**. Workspace breakdown: drive-sync **33 files / 292**, drive-connect **2 / 35**, project-sync **13 / 231**, calendar **23 / 338**. Calendar's entire unit suite ran through root, including unchanged ribbon/sticky units, so no redundant standalone calendar unit run. Root output: `/home/mohan/.local/share/opencode/tool-output/tool_17c61a8b20016ZbhfL38lZ0ZKA`.
- `npm run test:theme-browser -w @open-webapp/calendar`: **PASS**, exit 0, **2 files / 49 tests** (ribbon **8**, theme **41**), 16.52s. No failed/skipped tests. Empty-Today and same-day scroll 0/100/250, short ribbon, resize 400->320px and mounted dark-theme cases pass unchanged <2px tolerance. Measured center error **0.0078125px**, including empty-Today scroll0 (258.9921875 vs259), resized (218.9921875 vs219), dark resized scroll100 (203.4921875 vs203.5).
- `npm run build -w @open-webapp/calendar`: **PASS**, exit 0.
- `npx tsc --noEmit -p packages/calendar/tsconfig.json`: **PASS**, exit 0, no diagnostics; executed separately from build.
- `npm run build`: **PASS**, exit 0; builds drive-sync, drive-connect, project-sync, calendar and drive-sync-oauth-tester (Vite 20 modules). Calendar build repetition here follows root's configured all-workspace build gate.
- `bash scripts/check-contracts.sh`: **PASS**, exit 0, `contracts OK`.
- Audited root and every packages/apps workspace manifest's scripts: no configured lint, typecheck or additional check scripts. **Configured lint: N/A**. Required standalone calendar typecheck is covered above. Existing React act warnings, expected error-path stderr and npm's existing `-ws` deprecation warning were nonfatal; no unexpected command/test failure or flaky classification occurred.
- Full docs concept sweep: `git grep -n -i -E 'unaccepted|exclusive|saved.{0,40}(selection|rsvp)|restor.{0,40}(selection|rsvp)|savedSelection|isExclusive|handleUnaccepted|needsAction|DEFAULT_RSVP_STATUSES|calendar-day-header-height|ribbon' -- '*.md' ':!plans/*'`; separately swept tracked plans with the RSVP expression and calendar source/tests with that expression. Read the untracked current plan directly. Inspected matches: four current calendar docs agree on independent membership/default-on O/fallback/empty host sets/current theme selection and measured ribbon geometry; remaining shortcut descriptions explicitly historical/superseded. Other exclusive matches concern date boundaries, unrelated API fields or historical plans; calendar-selection persistence and round-trip wording are valid. No stale saved/exclusive implementation path or current contract claim found. schema-spec remains absent/N/A.
- Diff/acceptance review: four chips use current membership and the same cloning/fallback helper; defaults and core filter/controller unchanged. Controlled-host tests cover visible events and pressed state, mixed/singleton/empty external sets, fresh host updates, last-status fallback, double click and immutability. Badge-before-filter, zero/99+/accessible counts and chip order retained. Theme tests retain focus/search/selection/callback assertions. Ribbon uses actual bounds and shared observer with identity-targeted chip sizing, scroll/resize/content/date/theme invalidation and cleanup; absolute windows are not observed, and heights/offsets are clamped. Deterministic local-date fixtures and original geometric tolerance remain. No acceptance blocker found.
- Node JSON/assert validation: **PASS**; manifest and lock calendar versions both **0.8.0**; deep comparison with HEAD lock after changing only its calendar version proves no other lock fields changed. Calendar has only external peers; prior T4 workspace-peer verification remains applicable, and no dependent calendar peer requires an update.
- `git diff --check`: **PASS**. Inspected full diff/status: **13 intended tracked files, 282 insertions / 93 deletions**, plus this untracked plan. Only approved calendar source/tests/four docs/manifest/root lock changed. Build outputs and node_modules are ignored (`git status --short --ignored`); no generated tracked/untracked additions. No implementation/test/docs/metadata edits made during T5.
- **T5 accepted; ready for commit.** All requested gates green, no unresolved failures. T6+ deliberately pending under user's no-commit instruction; no commit, push, PR or tag, and original main worktree untouched.

## T6 execution — prior-to-commit evidence

- User authorized T6 ONLY in this existing worktree, direct execution without nested delegation. Read repository CLAUDE.md, global RTK instructions and the complete plan. Later checks/merge/tag/cleanup tasks remain outside this execution scope.
- Inspected `git status --short`, full `git diff`, `git diff --stat`, and `git log --oneline -10`. Exactly 13 intended tracked files plus this plan; no secrets or unrelated files identified in the reviewed changes. No implementation changes during T6.
- `git fetch origin` succeeded. HEAD and fetched origin/main both resolve to `581d517f6fd7d2551f43a1523b90fb6758a063b8`; `git log --oneline origin/main..HEAD` is empty before commit. Reviewed remote URLs, branch listings/tracking configuration and origin/main base diff. Current feature branch has no upstream yet; origin is `git@github-owa:open-webapp/owa.git`.
- `git diff --check` passed. Retain actual T5 evidence above: root 896/896 (calendar 338/338), browser 49/49, calendar/root builds, standalone types and contracts green; configured lint N/A. No test reruns needed for this plan-only execution update.
- Intended staging is the 13 validated source/test/doc/metadata files and this plan, followed by exact staged-diff review before committing. Planned breaking commit describes independent RSVP membership and the approved ribbon visible-intersection repair, with a BREAKING CHANGE footer. Commit/hook/push/PR results are deliberately not claimed here; later actual evidence will be in the PR and execution report.
