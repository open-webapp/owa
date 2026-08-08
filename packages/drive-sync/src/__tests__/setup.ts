// Installs `indexedDB` / `IDBKeyRange` globals so code (and the `idb` package)
// that talks to IndexedDB works unmodified under Vitest's Node environment.
import 'fake-indexeddb/auto'
