# Claude Code Rules

## Auto-tagging on commit

When changes to `packages/drive-sync`, `packages/project-sync`, `packages/drive-connect`, `packages/calendar`, `packages/notes-core`, or `packages/contacts` land on `main`, automatically create and push a git tag on the commit that landed on `main` matching the corresponding version pattern to trigger the publish workflow.

**For drive-sync:** After changes to `packages/drive-sync` land on `main`, extract the version from `packages/drive-sync/package.json` and run:
```bash
git tag drive-sync-v<version>
git push origin drive-sync-v<version>
```

**For project-sync:** After changes to `packages/project-sync` land on `main`, extract the version from `packages/project-sync/package.json` and run:
```bash
git tag project-sync-v<version>
git push origin project-sync-v<version>
```

**For drive-connect:** After changes to `packages/drive-connect` land on `main`, extract the version from `packages/drive-connect/package.json` and run:
```bash
git tag drive-connect-v<version>
git push origin drive-connect-v<version>
```

**For calendar:** After changes to `packages/calendar` land on `main`, extract the version from `packages/calendar/package.json` and run:
```bash
git tag calendar-v<version>
git push origin calendar-v<version>
```

**For notes-core:** After changes to `packages/notes-core` land on `main`, extract the version from `packages/notes-core/package.json` and run:
```bash
git tag notes-core-v<version>
git push origin notes-core-v<version>
```

**For contacts:** After changes to `packages/contacts` land on `main`, extract the version from `packages/contacts/package.json` and run:
```bash
git tag contacts-v<version>
git push origin contacts-v<version>
```

After pushing a package tag, ALWAYS report the publish status in the same turn: check the "Publish packages" run for that tag (`gh run list --limit 5`, wait via `gh run watch <id>` if still running) and confirm the new version on npm (`npm view @open-webapp/<package> version`). Report success, failure (with the failing step), or still-running; never end the turn with only "tag pushed".

This automates the release process by triggering the publish workflow without manual tag creation. Each package has its own independent versioning and release lifecycle.

Consumers of `notes-core` must pin its exact published version rather than use a version range.

## Keeping peer dependencies current

When upgrading a dependent package, make sure all of its peer packages are bumped to depend on the latest published versions of their peers.

Whenever `packages/drive-sync` is upgraded, ALWAYS update `packages/project-sync` in the same change: set its `peerDependencies` and `devDependencies` on `@open-webapp/drive-sync` to the new version range, bump `project-sync`'s version, and publish it using the normal commit, tag, and push workflow.

For example, `project-sync@latest` (0.1.4) still peers `drive-sync@^0.5.0` even though a newer `drive-sync` has been published. When touching `project-sync`, update its `peerDependencies` (and `devDependencies`) to reference the current `drive-sync` version, then bump `project-sync`'s own version so the change gets published.

Apply the same rule to any package in `packages/` that declares a peer on another workspace package: before publishing, verify the peer range covers the latest published version of that peer, and widen or bump it if not.

## Public behavior contracts are frozen unless explicitly requested

Never change the observable behavior of a published package's public API (return values, thrown errors, whether it opens UI/popups) as a side effect of another task, "fix", or refactor. Only do so when the user explicitly asks for that specific change, and mark it as breaking in the commit message and version.

Specifically, `drive-connect`'s `ensureFresh()` MUST fall through to the interactive `connect()` flow when the token is missing/unusable; it must NEVER throw `NeedsReauthError` instead. This is locked by tests 3, 5 and 5b in `packages/drive-connect/src/__tests__/auth.test.ts`. If a test encodes a contract, never edit the test to match changed code; ask the user first.

Contract tests are enforced in CI by `scripts/check-contracts.sh` (`.github/workflows/ci.yml`). Run it before committing any change under `packages/drive-connect`.

## Shared peer ranges must stay aligned across packages

MUST ensure the ERESOLVE incident (contacts 0.1.0 peered `vitest ^2.1.0` while consumers ran vitest 4; fixed in contacts 0.1.1) never recurs. npm checks peer ranges even for optional peers when the package is present, so a stale range breaks consumer installs.

- Any package in `packages/` that declares a peer on a third-party tool shared by several packages (`vitest`, `react`, etc.) MUST use the same widened range as its siblings. Before publishing, compare the `peerDependencies` of every package and make them consistent, covering every major version consumers use (e.g. `^2.1.0 || ^4`).
- When adding or bumping a peer range in one package, grep all `packages/*/package.json` for the same peer and update the others in the same change.
- New packages must copy peer ranges from the current latest published siblings, never from an old template.
- Keep a regression test asserting the peer range accepts the versions consumers use (see `packages/contacts/src/__tests__/peerRange.test.ts`); add the equivalent when a package gains a peer.

## Calendar dates use local browser time

In `packages/calendar`, any "today" or date key derived from a `Date` must use the browser's local time (`getFullYear` / `getMonth` / `getDate`). Never use `toISOString().slice(0, 10)` (UTC) for this. Pure UTC arithmetic on date strings (e.g. `addDaysToIso`) may use UTC.

## Agent instructions

The Claude agent (Claude Code) follows this file, `CLAUDE.md`. It does not use `AGENTS.md`, which is for other agents/tools.
