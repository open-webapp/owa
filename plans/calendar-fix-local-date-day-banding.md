# Plan: calendar local-date today + day-parity ribbon

## Status
Draft. Not started. Version now 0.6.1 -> 0.7.0 (breaking in 0.x = minor).

## Goal
Bug: "today" use UTC (toISOString().slice(0,10)). Evening in UTC-minus tz, today = tomorrow. Fix: local date. Also ribbon stop flag today, instead alternate 2 tones by day parity. Remove --calendar-today-accent.

## Scope
- Local toIsoDate in both copies.
- data-today -> data-parity="even|odd"; new tokens --calendar-day-ribbon-a/-b (light+dark).
- Remove --calendar-today-accent. Breaking.
- Docs, CLAUDE.md rule, version bump, PR flow, tag.

## No Scope
- Event day keys (events.ts:116-121 start.dateTime.slice(0,10)) stay.
- getRollingWindow (UTC ISO ok, instants).
- No refactor, no shared util, no deprecated alias.
- Never touch drive-connect contract tests.

## Decisions
1. Both toIsoDate use getFullYear/getMonth/getDate (browser-local).
2. parity = floor(Date.UTC(y,m-1,d)/86400000) mod 2 of dateKey. Stable on scroll/filter/month edge. Empty synthesized today group same rule. Sticky header "Today · Oct 26" unchanged.
3. Remove --calendar-today-accent fully. Commit `feat(calendar)!:` + BREAKING CHANGE footer. README migration note.
4. Root CLAUDE.md rule: today/date key from Date in packages/calendar = local time, never toISOString().slice(0,10).
5. Version 0.6.1 -> 0.7.0.

## Findings
- `src/core/events.ts:54-56` toIsoDate UTC. Used only at `:197` in addDaysToIso.
- TRAP: addDaysToIso builds `Date.UTC(...)` + setUTCDate (`:195-196`). If toIsoDate go local, UTC-plus tz shifts result by a day (Tomorrow label wrong). Must keep addDaysToIso UTC-safe: use `d.toISOString().slice(0,10)` inline THERE (date made from pure UTC parts, not "today"; safe) or UTC getters. Local toIsoDate then only for real "now".
- `src/core/events.ts` exports: groupByDay(events, todayIso) `:143`, formatDayHeader `:204`; todayIso computed by caller, so events.ts toIsoDate local copy only matters via addDaysToIso. Still change per decision 1 (export-free, keep private).
- `src/react/CalendarPane.tsx:149-151` toIsoDate; `:199` todayIso; `:260` groupByDay; `:263` scroll target; `:493` header; `:501` data-today.
- `src/react/styles.css:14` (light), `:221` rule `[data-today='true']`, `:398`, `:440` (dark, explicit + media). Verify exact lines in worktree.
- Docs: README.md:214,228; SPEC.md:89,93 (variables list); product-behavior.md has no today-accent hit (check ribbon mention by grep "ribbon").
- Existing test `src/react/__tests__/CalendarPane.ribbon.test.tsx:8-9,30-35` fakes noon, asserts data-today. Must change. Also check `cssPaletteContract.ts` + theme tests for token lists (grep today-accent in src showed only styles.css, so likely none).
- CI (`.github/workflows/ci.yml`) runs only check-contracts + drive-connect tests + drive-sync build. Calendar tests NOT in CI -> run locally. No lint script in repo; typecheck = `npx tsc --noEmit` in packages/calendar.

## Dependency Graph
T0 -> T1 -> T2 -> T3 -> T4 -> T5 -> T6
(T4 may run after T3 only; T5 needs all.)

## Tasks

### T0 — Worktree
model: haiku
Deps: none. Files: none.
Do: from /home/user/owa: `git fetch; git worktree add ../worktree-calendar-local-date -b fix/calendar-local-date origin/main`; cd; `npm install --legacy-peer-deps`.
Tests: n/a.
Acceptance: worktree exists, branch not main, cwd inside.

### T1 — Baseline gate
model: haiku
Deps: T0. Files: none unless red.
Do: `cd packages/calendar; npx vitest run; npx tsc --noEmit; cd ../..; ./scripts/check-contracts.sh`.
Tests: happy: all green -> go on. Edge: flaky -> rerun once. Error: red on main -> per planner rules, fix on separate branch, commit, PR, merge to main first, then rebase worktree. Report to user if fix not small.
Acceptance: baseline green recorded (counts).

### T2 — Failing regression tests (red first)
model: sonnet
Deps: T1.
Files: `packages/calendar/src/react/__tests__/CalendarPane.ribbon.test.tsx`, `packages/calendar/src/core/__tests__/events.test.ts`.
Do (<=30m):
- Ribbon test: replace data-today test with parity tests. Fake Date with `vi.useFakeTimers({toFake:['Date']})`.
- Add new test file `CalendarPane.localDate.test.tsx` if tz stub easier: set `process.env.TZ='America/Los_Angeles'` at top of file BEFORE any Date use (vitest worker: set in file's first line; if not honoured, add `vitest.config` env `TZ` only for this file via `// @vitest-environment` no; fallback run with `TZ=... vitest run file` in npm script-free way, document).
- Time: `new Date('2026-10-26T20:00:00-07:00')` (= UTC Oct 27 03:00).
Cases:
- happy: header "Today · Oct 26" for event on 2026-10-26; "Tomorrow · Oct 27" for 10-27; scroll-to-today targets 10-26 header.
- happy: ribbons alternate data-parity even/odd across consecutive days; Oct 26 2026 parity = epoch-day mod 2 (compute in test from Date.UTC, not hardcoded copy of impl).
- edge: month boundary Oct 31 -> Nov 1: parity differs (consecutive days always alternate); Dec 31 -> Jan 1 too.
- edge: filter removes middle day -> remaining days keep same parity as before filter.
- edge: empty today (no events today) synthesized group has data-parity matching rule.
- edge: no `[data-today]` attribute anywhere; today ribbon not special.
- edge: UTC-plus tz (Asia/Kolkata 00:30 Oct 27 local = Oct 26 UTC) today=Oct 27, "Tomorrow" = Oct 28 (guards addDaysToIso trap). In events.test.ts: formatDayHeader('2026-10-28','2026-10-27') -> Tomorrow under TZ=Asia/Kolkata.
- error: none thrown path; invalid dateKey unchanged behaviour (existing tests).
Acceptance: new tests FAIL on current code for the right reason (UTC key / missing data-parity); other tests pass.

### T3 — Minimal fix
model: sonnet
Deps: T2.
Files: `src/core/events.ts`, `src/react/CalendarPane.tsx`, `src/react/styles.css`.
Do:
- both toIsoDate body: `const p=(n:number)=>String(n).padStart(2,'0'); return \`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}\`;`
- events.ts addDaysToIso: keep UTC: return `d.toISOString().slice(0,10)` (d from Date.UTC parts). Add comment why.
- CalendarPane.tsx `:501`: replace data-today with `data-parity={dayParity(group.dateKey)}`; add small local helper dayParity(dateKey): parse y-m-d, `Math.floor(Date.UTC(y,m-1,d)/86400000)%2===0?'even':'odd'`. Remove any unused todayIso uses only if now dead (todayIso still used at 260/263/493).
- styles.css: delete `--calendar-today-accent` at `:14`,`:398`,`:440`; add `--calendar-day-ribbon-a/-b` in same three blocks (light a/b distinct subtle tones, dark equivalents; keep text contrast on label vs both). Replace `[data-today='true']` rule `:219-222` with `[data-parity='even']{background:var(--calendar-day-ribbon-a)}` and odd -> -b, color set to readable token.
Tests: run T2 tests + full calendar suite + theme tests (palette contract).
Acceptance: T2 green; `grep -rn "today-accent\|data-today" src` empty; tsc clean.

### T4 — Docs + version
model: haiku
Deps: T3.
Files: `packages/calendar/README.md` (214, 228), `packages/calendar/SPEC.md` (89, 93), `packages/calendar/product-behavior.md` (ribbon mention if any), `/CLAUDE.md`, `packages/calendar/package.json`.
Do:
- README: describe alternating ribbon, tokens -a/-b; migration note "--calendar-today-accent removed; use --calendar-day-ribbon-a/-b".
- SPEC: line 89 parity ribbon, today not flagged; line 93 variables list swap token; note today = local date.
- product-behavior.md: add/adjust if ribbon/today described.
- CLAUDE.md: new section "Calendar dates are local" with rule from decision 4.
- package.json version 0.7.0. Check package-lock entry for calendar, update if present.
Tests: n/a. Edge: grep old token in repo docs = 0 hits (except migration note).
Acceptance: greps clean; version 0.7.0. No other package peers calendar (verify grep "@open-webapp/calendar" in packages/*/package.json; if peer exists bump per peer rule).

### T5 — Validate
model: haiku
Deps: T4.
Do: in packages/calendar `npx vitest run`, `npx tsc --noEmit`, `npm run build`; also run new tests with `TZ=America/Los_Angeles` and `TZ=Asia/Kolkata`; root `./scripts/check-contracts.sh`. Do not edit contract tests.
Tests: happy all green; edge tz matrix; error any red -> fix in T3, rerun.
Acceptance: all green, `git diff --stat` only planned files.

### T6 — Commit, PR, gate, merge, tag
model: sonnet
Deps: T5.
Do:
- Commit on fix/calendar-local-date (NOT main): `feat(calendar)!: use local date for today; alternate day ribbon tones` body + footer `BREAKING CHANGE: --calendar-today-accent removed; ribbon no longer highlights today (data-today -> data-parity). Use --calendar-day-ribbon-a/-b.` Trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VJYzGGygkc4kgY9B2B3dFC`.
- `git push -u origin fix/calendar-local-date`; `gh pr create --base main`; body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` + session URL.
- Poll `gh pr checks <pr>` every 30-60s until none pending.
- All pass (and at least one reported): `gh pr merge <pr> --merge`; `git checkout main && git pull`; `git tag calendar-v0.7.0; git push origin calendar-v0.7.0`.
- Any fail or none report: no merge, no tag; `gh run view --log-failed`, report, stop.
Tests: edge: zero checks reported = treat as fail. error: push rejected -> stop, report.
Acceptance: PR merged, tag on merge commit pushed, or stopped with report.

### T-final — Cleanup worktree
model: haiku
Deps: T6.
Do: cd /home/user/owa; `git worktree remove ../worktree-calendar-local-date`; delete branch only if merged.
Acceptance: worktree gone, tag/commit exist.

## Test Strategy
Unit (events.test.ts) + component (ribbon/localDate tests) under fake Date and TZ matrix (LA, Kolkata, UTC). Existing suite + theme palette tests guard CSS. Calendar tests not in CI so local run is the gate.

## Acceptance
- At 20:00 Oct 26 LA: header "Today · Oct 26"; Tomorrow = Oct 27.
- Ribbons alternate parity incl. month/year boundary; no data-today.
- Old token gone; new tokens in light, dark explicit, dark media.
- Version 0.7.0, breaking commit, tag calendar-v0.7.0 pushed after green PR.

## Risks
- addDaysToIso break in UTC-plus tz if toIsoDate local -> keep UTC inline, tested with Kolkata.
- TZ env in vitest may not apply after worker start -> set via script env/ run with TZ prefix; verify test truly fails pre-fix.
- CI does not run calendar tests -> "green checks" weak; local gate mandatory.
- Event keys still slice(0,10) of dateTime (offset of event, not browser tz) -> mismatch possible for events in other offsets; left per decision.
- Hosts using removed token lose styling -> breaking, documented.
- Ribbon tone contrast with label text.

## Post-change docs
README (usage + migration), SPEC (ribbon, variables), product-behavior.md if ribbon covered, root CLAUDE.md local-date rule, package.json version.
