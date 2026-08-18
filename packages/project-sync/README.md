# @open-webapp/project-sync

Lightweight project synchronization library for multi-project app state management.
Built on top of `@open-webapp/drive-sync` for reliable storage and sync primitives.

Owns orchestration (registry, per-project databases, sync scheduling, status) while apps keep their data shapes and merge logic. Supports any serialization, any merge strategy, any document set.

## Features

- **Project registry** — CRUD + unique-by-name (trimmed, case-insensitive) + ordered by creation time.
- **Per-project IndexedDB** — Package manages handles, versions, lifecycle; app defines stores.
- **Sync orchestration** — Interval + visibility-regain + debounce + single-flight per project + cross-tab leader election via BroadcastChannel.
- **Version-directed engine** — Try-write-first (zero reads/merges on baseline match) + read-merge-write fallback (bounded at 3 attempts).
- **React hooks** — Thin `useSyncExternalStore` wrappers; no components, no CSS.
- **Testing fakes** — In-memory fakes + exported contract suites for app-side merge verification.

## Installation

```bash
npm install @open-webapp/project-sync @open-webapp/drive-sync idb
```

## Quick start

```ts
import { createProjectSync } from '@open-webapp/project-sync';
import { createDriveSync } from '@open-webapp/drive-sync';

// Step 1: Create a shared drive-sync instance (caller-owned)
const drive = createDriveSync({
  appId: 'my-app',
  clientId: GOOGLE_CLIENT_ID,
  folderPath: ['OpenWebApp', 'My App'],
});

// Step 2: Create the project-sync instance
const app = createProjectSync({
  drive,
  appName: 'My App',
  registryDbName: 'my-app-registry',
  data: {
    version: 1,
    upgrade(db, oldV, newV, tx) {
      if (oldV < 1) {
        db.createObjectStore('documents', { keyPath: 'id' });
      }
    },
  },
  documents: (project) => [
    {
      key: 'primary',
      name: 'state.json',
      mimeType: 'application/json',
      readLocal() { /* ... */ },
      writeLocal(merged) { /* ... */ },
      merge(local, remote) { /* ... */ },
    },
  ],
  interval: 5 * 60 * 1000, // 5 minutes, or null for manual
});

// Step 3: Connect, create/select a project, and start syncing
await app.connection.connect();
const project = await app.projects.create('My First Project');
await app.projects.setActive(project.id);
app.sync.start();

// Subscribe to status updates
const unsubscribe = app.subscribe(({ phase, lastSyncedAt, error }) => {
  console.log(`Sync phase: ${phase}, last synced: ${lastSyncedAt}, error: ${error}`);
});
```

## Usage patterns by app shape

### Pattern 1: Simple JSON state (union merge with local-wins collision)

Notesdiary's model — filter rules stored as JSON, merged by union of rule ids:

```ts
interface Entry {
  id: string;
  timestamp: number;
  text: string;
}

interface Rule {
  id: string;
  name: string;
  filename: string;
}

const app = createProjectSync({
  drive,
  appName: 'Notes Diary',
  registryDbName: 'notes-diary-registry',
  data: {
    version: 2,
    upgrade(db, oldV, newV, tx) {
      if (oldV < 1) {
        const entriesStore = db.createObjectStore('entries', { keyPath: 'id' });
        entriesStore.createIndex('by-date', 'timestamp');
      }
      if (oldV < 2) {
        db.createObjectStore('meta'); // for filter rules, drive metadata
      }
    },
  },
  documents: (project) => {
    // Read filter rules from IDB; each rule is one document
    const meta = /* read from project's db */;
    return meta.filterRules.map((rule) => ({
      key: rule.id,
      name: `${rule.filename}.json`, // Ensure .json extension
      mimeType: 'application/json',
      async readLocal() {
        const tx = db.transaction('entries');
        const entries = await tx.store.getAll();
        // Filter entries by this rule's criteria, return JSON
        return JSON.stringify(filtered);
      },
      async writeLocal(merged) {
        const data = JSON.parse(merged);
        // Upsert entries into 'entries' store
        await db.put('entries', ...data);
      },
      async merge(local, remote) {
        const localEntries = local ? JSON.parse(local) : {};
        const remoteEntries = remote ? JSON.parse(remote) : {};
        // Union by id; local wins on collision
        const merged = { ...remoteEntries, ...localEntries };
        return { merged: JSON.stringify(merged), conflicts: [] };
      },
    }));
  },
  interval: 5 * 60 * 1000,
});
```

### Pattern 2: Encrypted state (remote-replace-or-local-wins)

Portfolio's model — single encrypted document, merged by decrypting both and choosing winner:

```ts
interface AppState {
  positions: Record<string, number>;
  selections: Record<string, string[]>;
}

const app = createProjectSync({
  drive,
  appName: 'Portfolio',
  registryDbName: 'portfolio-registry',
  data: {
    version: 1,
    upgrade(db, oldV, newV, tx) {
      if (oldV < 1) {
        db.createObjectStore('app_state');
      }
    },
  },
  documents: (project) => [
    {
      key: 'app-state',
      name: 'portfolio-state.json',
      mimeType: 'application/octet-stream',
      async readLocal() {
        const state = await db.get('app_state', 'current');
        if (!state) return null;
        // Encrypt to Uint8Array envelope
        const encrypted = await encryptState(state, userKey);
        return encrypted;
      },
      async writeLocal(merged) {
        // Decrypt Uint8Array
        const decrypted = await decryptState(merged, userKey);
        await db.put('app_state', decrypted, 'current');
      },
      async merge(local, remote) {
        // Decrypt both (or null if missing)
        const localState = local ? await decryptState(local, userKey) : null;
        const remoteState = remote ? await decryptState(remote, userKey) : null;
        // Remote-replace-or-local-wins: if remote exists and is newer, use it; else local
        const merged = (remoteState && remoteState.timestamp > localState?.timestamp)
          ? remoteState
          : localState || remoteState;
        return { merged, conflicts: [] };
      },
    },
  ],
  interval: 5 * 60 * 1000,
});
```

### Pattern 3: Tabular data with conflict resolution (CSV merge)

Planning's model — tasks + milestones as CSV with conflict dialog:

```ts
interface Task {
  id: string;
  name: string;
  completed: boolean;
}

const app = createProjectSync({
  drive,
  appName: 'Planning',
  registryDbName: 'planning-registry',
  data: {
    version: 1,
    upgrade(db, oldV, newV, tx) {
      if (oldV < 1) {
        db.createObjectStore('tasks', { keyPath: 'id' });
        db.createObjectStore('milestones', { keyPath: 'id' });
      }
    },
  },
  documents: (project) => [
    {
      key: 'tasks',
      name: 'tasks.csv',
      mimeType: 'text/csv',
      async readLocal() {
        const tasks = await db.getAll('tasks');
        // Serialize to CSV: id,name,completed
        return tasks.map(t => `${t.id},${t.name},${t.completed}`).join('\n');
      },
      async writeLocal(merged) {
        const lines = (merged as string).split('\n');
        const tasks = lines.map((line) => {
          const [id, name, completed] = line.split(',');
          return { id, name, completed: completed === 'true' };
        });
        const tx = db.transaction('tasks', 'readwrite');
        for (const task of tasks) await tx.store.put(task);
      },
      async merge(local, remote) {
        const localTasks = local ? parseCSV(local) : {};
        const remoteTasks = remote ? parseCSV(remote) : {};
        
        // Simple merge with conflict detection
        const merged = { ...localTasks };
        const conflicts = [];
        
        for (const [id, remoteTask] of Object.entries(remoteTasks)) {
          if (!localTasks[id]) {
            merged[id] = remoteTask; // Remote-only, take it
          } else if (localTasks[id].modified > remoteTask.modified) {
            // Local is newer, keep it (local wins)
            conflicts.push({ id, localTask: localTasks[id], remoteTask });
          } else {
            // Remote is newer or same, take remote
            merged[id] = remoteTask;
          }
        }
        
        return {
          merged: toCSV(merged),
          conflicts, // Surfaced to UI for user resolution
        };
      },
    },
  ],
  interval: 5 * 60 * 1000,
});
```

## React Integration

```tsx
import { ProjectSyncProvider, useProjects, useActiveProject, useSyncStatus } from '@open-webapp/project-sync/react';

export function App() {
  const [app] = useState(() => createProjectSync(/* ... */));
  
  return (
    <ProjectSyncProvider instance={app}>
      <ProjectList />
      <SyncStatus />
    </ProjectSyncProvider>
  );
}

function ProjectList() {
  const projects = useProjects(); // ProjectSync<any>[]
  const activeProject = useActiveProject();
  const { status } = useSyncStatus();
  
  return (
    <div>
      {projects.map((p) => (
        <button
          key={p.id}
          onClick={() => app.projects.setActive(p.id)}
          style={{ fontWeight: p.id === activeProject?.id ? 'bold' : 'normal' }}
        >
          {p.name}
        </button>
      ))}
      <button onClick={() => app.sync.syncNow()}>Sync now</button>
    </div>
  );
}

function SyncStatus() {
  const status = useSyncStatus();
  
  return (
    <div>
      <span>Phase: {status.phase}</span>
      <span>Last synced: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : 'never'}</span>
      {status.error && <span style={{ color: 'red' }}>Error: {status.error.message}</span>}
      {status.needsReauth && <span>Re-authentication required</span>}
    </div>
  );
}
```

## Testing

Use fakes for unit tests (no network, no IndexedDB required):

```ts
import { createProjectSyncFake } from '@open-webapp/project-sync/testing';

const app = createProjectSyncFake();

// Use like the real instance, but all in-memory
const project = await app.projects.create('Test Project');
await app.projects.setActive(project.id);

// Verify merge logic
import { describeMergeContract } from '@open-webapp/project-sync/testing';

describeMergeContract(
  myMergeFunction,
  {
    local: '{"a":1}',
    remote: '{"b":2}',
  },
  {
    expectedMerged: '{"a":1,"b":2}',
    expectedConflicts: [],
  }
);
```

## Core concepts

- **Adapter-based** — Package owns plumbing (registry, database lifecycle, sync scheduling); apps own data shapes and merge logic.
- **Names are truth** — Folder and file names are resolved by name, not cached id. IDs are optimizations, not the source of truth.
- **Try-write-first** — Syncs attempt a direct write (if the cached baseline matches Drive). Only on remote change does the engine read-merge-write.
- **Bounded conflict** — Conflicts are bounded at 3 write attempts. Unresolvable conflicts throw an error (never silent data loss).
- **One project-sync per app** — Each app owns one instance. Apps coordinate projects via the registry, not via separate instances.

## For more

- **[SPEC.md](./SPEC.md)** — All 36 resolved design decisions, storage layout, known limitations, rejected designs.
- **[Types (src/types.ts)](./src/types.ts)** — Complete interface definitions with comments.
- **[Testing guide](./src/testing/README.md)** — How to write merge tests + fakes.
