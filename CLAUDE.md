# Claude Code Rules

## Auto-committing package changes

When you modify files under `packages/drive-sync`, `packages/project-sync`, or `packages/drive-connect` as part of a task, commit those changes without waiting to be asked. Branch off `main` first, commit the change with a descriptive message, merge back to `main` (`--no-ff`), and push. Then follow the auto-tagging rule below.

This is a standing instruction: treat "the change is made" as "commit, merge, tag, and push" for these three packages.

## Auto-tagging on commit

When committing changes to `packages/drive-sync` or `packages/project-sync`, automatically create and push a git tag matching the corresponding version pattern to trigger the publish workflow.

**For drive-sync:** After creating a commit to `packages/drive-sync`, extract the version from `packages/drive-sync/package.json` and run:
```bash
git tag drive-sync-v<version>
git push origin drive-sync-v<version>
```

**For project-sync:** After creating a commit to `packages/project-sync`, extract the version from `packages/project-sync/package.json` and run:
```bash
git tag project-sync-v<version>
git push origin project-sync-v<version>
```

**For drive-connect:** After creating a commit to `packages/drive-connect`, extract the version from `packages/drive-connect/package.json` and run:
```bash
git tag drive-connect-v<version>
git push origin drive-connect-v<version>
```

This automates the release process by triggering the publish workflow without manual tag creation. Each package has its own independent versioning and release lifecycle.

## Keeping peer dependencies current

When upgrading a dependent package, make sure all of its peer packages are bumped to depend on the latest published versions of their peers.

For example, `project-sync@latest` (0.1.4) still peers `drive-sync@^0.5.0` even though a newer `drive-sync` has been published. When touching `project-sync`, update its `peerDependencies` (and `devDependencies`) to reference the current `drive-sync` version, then bump `project-sync`'s own version so the change gets published.

Apply the same rule to any package in `packages/` that declares a peer on another workspace package: before publishing, verify the peer range covers the latest published version of that peer, and widen or bump it if not.
