// Vitest global setup for @open-webapp/drive-connect.
//
// - `fake-indexeddb/auto` installs `indexedDB` / `IDBKeyRange` globals so the
//   `idb`-based storage layer inside `@open-webapp/drive-sync` works under
//   jsdom unchanged (mirrors drive-sync's own `__tests__/setup.ts`).
// - `@testing-library/jest-dom/vitest` registers the DOM matchers used by the
//   component tests in this package.
import 'fake-indexeddb/auto'
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// Clear every fake-indexeddb database between tests so open connections and
// persisted connection/token records don't leak across cases. drive-sync's
// own test setup does no clearing because each of its tests uses fresh
// app/project ids; drive-connect's harness pins fixed ids (`test-app` /
// `app`), so an explicit wipe is required for per-test isolation. drive-sync
// ships no shared clear helper, so this uses `indexedDB.databases()` +
// `indexedDB.deleteDatabase(...)`.
afterEach(async () => {
  const dbs =
    typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
  await Promise.all(
    dbs.map(
      (info) =>
        new Promise<void>((resolve) => {
          if (!info.name) {
            resolve()
            return
          }
          const req = indexedDB.deleteDatabase(info.name)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        }),
    ),
  )
})
