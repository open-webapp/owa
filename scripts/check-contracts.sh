#!/usr/bin/env bash
# Fails if a frozen public-behavior contract test is removed, renamed, or skipped.
set -euo pipefail
f=packages/drive-connect/src/__tests__/auth.test.ts
required=(
  "3. ensureFresh() token-runway boundary: interactive connect iff the cached token is not usable"
  "5. ensureFresh() + connect() in parallel fold into one popup"
  "5b. CONTRACT: ensureFresh() with no connection opens the connect flow and never throws NeedsReauthError"
)
for t in "${required[@]}"; do
  grep -qF "it('$t'" "$f" || { echo "MISSING contract test: $t"; exit 1; }
done
if grep -nE "(it|describe)\.(skip|todo)|\bxit\(" "$f"; then echo "Skipped tests not allowed in $f"; exit 1; fi
if grep -n "ensureFresh" -A8 packages/drive-connect/src/auth.ts | grep -q "throw new NeedsReauthError"; then
  echo "ensureFresh() must not throw NeedsReauthError"; exit 1
fi
echo "contracts OK"
