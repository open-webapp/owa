import type { DriveSync } from '@open-webapp/drive-sync';
import type { IDBPDatabase, IDBPTransaction } from 'idb';

/**
 * Opaque payload type — never parsed by the package.
 * Apps define how to serialize/deserialize their state into this shape.
 * Decision 10: no codec type exists; payloads stay opaque end-to-end.
 */
export type Payload = string | Uint8Array;

/**
 * Represents a synchronizable document — a unit of sync work.
 * Typically one file per document, but document identity (key) is app-defined.
 *
 * Decision 9: documents(project) is a function, not static config.
 * This allows the set of documents to change at runtime based on app state
 * (e.g., notesdiary's user-defined filter rules).
 */
export interface SyncDocument {
  /**
   * Stable local identity for this document, used to key sync state.
   * Must be unique per project. Not persisted to Drive.
   */
  key: string;

  /**
   * Drive file name — the source of truth for folder resolution.
   * Rename this and the old file is abandoned; a new one is created.
   * Decision 7: names are truth; cached IDs are disposable.
   */
  name: string;

  /**
   * MIME type for this document's Drive file.
   * Examples: 'application/json', 'text/csv', 'application/octet-stream'.
   */
  mimeType: string;

  /**
   * Read the latest local state.
   * Return null if the document does not exist locally yet
   * (e.g., first sync of a newly added rule in notesdiary).
   */
  readLocal(): Promise<Payload | null>;

  /**
   * Write a merged/resolved payload locally.
   * Called only when a merge happens or on pure-push success.
   * Decision 20: writeLocal is never called on pure push (when baseline matches).
   */
  writeLocal(merged: Payload): Promise<void>;

  /**
   * Merge local and remote state.
   * Decision 11: merge is app-supplied and required — package ships no default.
   * A default here is a silent-data-loss footgun.
   *
   * @param local - latest local state from readLocal(), or null if missing locally
   * @param remote - latest remote state from Drive, or null if missing on Drive
   * @returns merged state and any conflicts (data, never rendered by the package)
   */
  merge(
    local: Payload | null,
    remote: Payload | null
  ): Promise<{ merged: Payload; conflicts: unknown[] }>;
}

/**
 * A project — a folder in Drive and a database in IndexedDB.
 * Created/managed by the package; apps read/list them via hooks or direct API.
 */
export interface Project {
  /** Opaque stable id, generated at creation. */
  id: string;

  /** User-assigned name, unique (case-insensitive, trimmed) per app. */
  name: string;

  /** ISO timestamp of project creation. */
  createdAt: string;
}

/**
 * Sync phase — one of the states in the sync lifecycle.
 */
export type SyncPhase = 'idle' | 'syncing' | 'error';

/**
 * Per-document sync state — cached Drive file id, last sync timestamp, current status.
 * Exposed read-only so apps can render "last synced" and can decide per-document Drive deletion.
 * Decision 32: package never deletes Drive files automatically.
 */
export interface DocumentState {
  /** Cached Drive file id. Null until first sync (or if creation failed). */
  driveFileId: string | null;

  /**
   * Epoch milliseconds of the last successful sync for this document.
   * Null until first sync. Does not update on pure-push (decision 20).
   */
  lastSynced: number | null;

  /** Current status: pending, synced, or an error. */
  status: 'pending' | 'syncing' | 'synced' | 'error';
}

/**
 * Live sync status observable — emitted to all subscribers on state change.
 * Immutable snapshots safe for use with useSyncExternalStore.
 */
export interface SyncStatus {
  /** Current phase: idle, syncing, or error. */
  phase: SyncPhase;

  /** Epoch ms of the last successful sync across all documents. Null if never. */
  lastSyncedAt: number | null;

  /**
   * The last error that occurred during sync, if any.
   * Cleared on next successful sync.
   * Re-exported from drive-sync's error types plus package-specific errors.
   */
  error: Error | null;

  /**
   * True when the connected account needs re-authentication
   * (scope revoked, token truly expired, etc.).
   * Polled locally every 60s with no network call.
   */
  needsReauth: boolean;

  /**
   * Conflict data from the last sync, if any.
   * Each merge() can return conflicts; they are surfaced here
   * and never auto-resolved by the package.
   * Empty array if no conflicts.
   */
  conflicts: unknown[];
}

/**
 * Configuration for createProjectSync().
 * Decision 11: merge is required (enforced by TypeScript — no optional).
 */
export interface ProjectSyncOptions {
  /**
   * Caller-owned DriveSync instance.
   * Decision 2: drive-sync is a peerDependency.
   * A duplicate copy in the tree means two token refreshers racing,
   * so make it an install-time error.
   */
  drive: DriveSync;

  /**
   * App display name for Drive folder hierarchy.
   * Results in folderPath = ['OpenWebApp', appName].
   * Decision 5: uniform layout for all three apps.
   */
  appName: string;

  /**
   * IndexedDB database name for the project registry.
   * App-specific to avoid collisions when multiple apps are on the same device.
   * Example: 'notes-diary-registry'.
   */
  registryDbName: string;

  /**
   * Per-project database configuration.
   * The package derives the per-project db name from the project id,
   * but the app supplies how the database should be structured (version, upgrade).
   *
   * Decision 4: IndexedDB is mandatory for project data.
   * The package owns the handle cache and lifecycle (open/close/delete).
   * The app supplies only this shape.
   */
  data: {
    /** IndexedDB schema version. Package runs upgrade() on every open if needed. */
    version: number;

    /**
     * Called by the package to set up (or migrate) the database on open.
     * Package stores are managed by the package; this upgrades app stores.
     * Signature matches IDBDatabase.onupgradeneeded's transaction.
     */
    upgrade(
      db: IDBPDatabase<any>,
      oldVersion: number,
      newVersion: number,
      tx: IDBPTransaction<any, any[], 'versionchange'>
    ): void | Promise<void>;
  };

  /**
   * Compute the set of documents to sync for a given project.
   * Called fresh on every sync so the set can be dynamic (e.g., filter rules in notesdiary).
   * Decision 9: documents is a function, not static config.
   *
   * The app is responsible for:
   * - Only including documents that should actually sync
   * - Handling rules that add/remove at runtime
   * - Returning an empty array is valid (e.g., while data is loading)
   *   but never interpreted as "delete all Drive files" (decision 32)
   */
  documents: (project: Project) => SyncDocument[];

  /**
   * Sync interval in milliseconds, or null for manual-only.
   * When provided, syncs run on this interval, excluding paused/disconnected states.
   *
   * Decision 14: package owns the scheduler.
   * Includes visibility regain, debounced markDirty(), single-flight per project,
   * and cross-tab leader election via BroadcastChannel.
   */
  interval: number | null;

  /**
   * Optional logger for debugging (defaults to no-op).
   * Receives `log(level, message, context?)` calls from the sync loop.
   */
  logger?: {
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: unknown): void;
  };
}

/**
 * The main ProjectSync instance returned by createProjectSync().
 * Owns registry, per-project databases, connection, sync scheduling, and status.
 *
 * Decision 1: adapter-based, not canonical-model.
 * The package owns orchestration; apps keep their data shapes.
 */
export interface ProjectSync {
  /**
   * Projects registry and CRUD operations.
   * Decision 33: list() returns projects in createdAt ascending order.
   * No other ordering API; presentation state (pinning, recency) stays app-side.
   */
  projects: {
    /** List all projects, sorted by creation time. */
    list(): Promise<Project[]>;

    /** Get a single project by id. */
    get(id: string): Promise<Project | null>;

    /** Create a new project. Name is required and must be unique (trimmed, case-insensitive). */
    create(name: string): Promise<Project>;

    /** Rename a project. New name must be unique. */
    rename(id: string, name: string): Promise<Project>;

    /** Remove a project. Never touches Drive files (decision 31). */
    remove(id: string): Promise<void>;

    /** Set the active project. Subsequent getActiveDb() returns this project's database. */
    setActive(id: string): Promise<void>;

    /** Get the currently active project, or null if none. */
    getActive(): Promise<Project | null>;
  };

  /**
   * Per-project data store access.
   * The package manages handles, versions, and lifecycle (on open/close/delete).
   */
  data: {
    /**
     * Get the active project's database handle.
     * Throws a clear error if no project is active — never silently defaults.
     * Decision 4: this is the only way to reach a handle; getActiveDb() is mandatory.
     */
    getActiveDb(): Promise<IDBPDatabase<any>>;

    /**
     * Get read-only sync state for a document in a given project.
     * Used by apps to render "last synced" and to decide per-document Drive deletion.
     * Decision 32: package exposes the state; apps decide what to do with it.
     */
    getDocumentState(projectId: string, docKey: string): Promise<DocumentState | null>;

    /**
     * Forget sync state for a document.
     * Used when an app removes a document from its set (e.g., deletes a filter rule).
     * The package never infers deletion from a document vanishing from documents(project).
     * Decision 32: auto-deleting Drive files for vanished documents is rejected;
     * the cold-start window (documents(project) returns [] before data loads) would silently
     * destroy all backups in the project.
     */
    forgetDocument(projectId: string, docKey: string): Promise<void>;
  };

  /**
   * Connection management (OAuth, account info).
   * One app-wide connection shared across all projects (decision 12).
   */
  connection: {
    /** Initiate interactive OAuth connect. */
    connect(): Promise<void>;

    /** Disconnect and clear stored credentials. */
    disconnect(): Promise<void>;

    /**
     * Get current connection state (email, reauth-needed flag).
     * Null if not connected.
     */
    status(): Promise<{ email: string; needsReauth: boolean } | null>;
  };

  /**
   * Sync control and scheduling.
   * Decision 14: package owns the scheduler (interval, visibility regain, debounce, single-flight, leader election).
   */
  sync: {
    /** Start the sync scheduler (if an interval was provided). */
    start(): void;

    /** Stop the sync scheduler. */
    stop(): void;

    /**
     * Trigger an immediate sync now, optionally for a specific project.
     * If a sync is already in flight, returns the existing promise.
     * Single-flight per project.
     */
    syncNow(projectId?: string): Promise<void>;

    /**
     * Mark a project as dirty to trigger a sync after the debounce period.
     * Used by apps to request sync on state mutation (e.g., entry added/edited).
     * Debounced; multiple calls within the debounce window = one sync.
     */
    markDirty(projectId: string): void;
  };

  /**
   * Subscribe to sync status changes.
   * Snapshots are immutable and referentially stable when unchanged
   * (safe for use with useSyncExternalStore).
   * Unsubscribe by calling the returned cleanup function.
   */
  subscribe(callback: (status: SyncStatus) => void): () => void;
}

/**
 * Type helper: extract the project type (for app-defined metadata extensions).
 * Useful in type-safe merge implementations.
 */
export type ProjectFrom<T extends ProjectSync> = T extends ProjectSync ? Project : never;

/**
 * Type helper: extract the SyncDocument interface.
 */
export type SyncDocumentFrom<T> = T extends { documents: (p: any) => (infer D)[] } ? D : never;
