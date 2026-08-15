# Claude Code Rules

## Auto-tagging on commit

When committing changes to the `packages/drive-sync` package, automatically create and push a git tag matching the `drive-sync-v*` pattern to trigger the publish workflow.

**How:** After creating a commit to drive-sync, extract the version from `packages/drive-sync/package.json` and run:
```bash
git tag drive-sync-v<version>
git push origin drive-sync-v<version>
```

This automates the release process by triggering the publish workflow without manual tag creation.
