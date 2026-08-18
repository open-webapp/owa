# Claude Code Rules

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

This automates the release process by triggering the publish workflow without manual tag creation. Each package has its own independent versioning and release lifecycle.
