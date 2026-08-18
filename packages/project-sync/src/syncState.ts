/**
 * Per-document sync state management — single writer + serialized persist queue.
 *
 * Implements decisions 23 and 32:
 * - Own { [docKey]: { status, driveFileId, lastSynced } } per project
 * - Single update() entry point that mutates synchronously (no await in critical section)
 * - Promise-chained persist queue so writes land in call order
 * - Mirror updates to status observable
 * - Only persist 'synced' status; transient 'syncing' is not persisted
 * - Failed persist must not wedge the queue
 *
 * This was the exact bug notesdiary just fixed: concurrent per-document syncs
 * committed closure-captured maps and clobbered each other's driveFileId/lastSynced.
 * The fix requires both synchronously-updated in-memory map AND promise-chained queue.
 */

import type { IDBPDatabase } from 'idb';
import type { DocumentState, SyncStatus } from './types.js';

/**
 * Internal representation of document sync state.
 */
export interface DocumentSyncState {
  driveFileId: string | null;
  lastSynced: number | null;
  status: 'pending' | 'syncing' | 'synced' | 'error';
  error?: Error;
  conflicts?: unknown[];
}

/**
 * Callback for sync status changes.
 */
export type StatusCallback = (status: SyncStatus) => void;

/**
 * In-memory sync state map: { [projectId]: { [docKey]: DocumentSyncState } }
 */
type SyncStateMap = Record<string, Record<string, DocumentSyncState>>;

/**
 * Per-document sync state manager with single writer and serialized persist queue.
 */
export class SyncStateManager {
  private map: SyncStateMap = {};
  private persistQueue: Promise<void> = Promise.resolve();
  private statusCallbacks: Set<StatusCallback> = new Set();
  private getDb: () => Promise<IDBPDatabase<any>>;
  private registryDbName: string;
  private lastSyncedAtPerProject: Record<string, number | null> = {};

  constructor(getDb: () => Promise<IDBPDatabase<any>>, registryDbName: string) {
    this.getDb = getDb;
    this.registryDbName = registryDbName;
  }

  /**
   * Initialize sync state by loading from storage for all projects.
   * Called once at startup.
   */
  async init(): Promise<void> {
    // Load existing sync state from registry for all projects
    const db = await this.getDb();
    const projects = await db.getAll('projects');

    for (const project of projects) {
      this.map[project.id] = {};
      // Load sync state from the registry db if it exists
      const stateData = await db.get('_syncStates', project.id);
      if (stateData) {
        this.map[project.id] = stateData.states || {};
        this.lastSyncedAtPerProject[project.id] = stateData.lastSyncedAt || null;
      }
    }
  }

  /**
   * Get read-only document state.
   * Returns null if the document has never been synced.
   */
  getDocumentState(projectId: string, docKey: string): DocumentState | null {
    const projectStates = this.map[projectId];
    if (!projectStates) return null;

    const state = projectStates[docKey];
    if (!state) return null;

    return {
      driveFileId: state.driveFileId,
      lastSynced: state.lastSynced,
      status: state.status,
    };
  }

  /**
   * Get all document states for a project.
   */
  getDocumentStates(projectId: string): Record<string, DocumentState> {
    const projectStates = this.map[projectId];
    if (!projectStates) return {};

    const result: Record<string, DocumentState> = {};
    for (const [docKey, state] of Object.entries(projectStates)) {
      result[docKey] = {
        driveFileId: state.driveFileId,
        lastSynced: state.lastSynced,
        status: state.status,
      };
    }
    return result;
  }

  /**
   * Update sync state atomically.
   * All mutations go through this single entry point.
   * The critical section is synchronous (no await), so concurrent updates accumulate.
   *
   * @param projectId - The project owning this document
   * @param fn - Function to apply to the project's state map; mutations are synchronous
   * @returns Promise that resolves when the change is persisted
   */
  async update(
    projectId: string,
    fn: (states: Record<string, DocumentSyncState>) => void
  ): Promise<void> {
    // Ensure project exists in map
    if (!this.map[projectId]) {
      this.map[projectId] = {};
    }

    // CRITICAL SECTION: synchronous, no await
    // Apply the mutation function to the in-memory map
    fn(this.map[projectId]);

    // Calculate new lastSyncedAt for this project
    const states = this.map[projectId];
    let newLastSyncedAt: number | null = null;
    for (const state of Object.values(states)) {
      if (state.status === 'synced' && state.lastSynced) {
        if (newLastSyncedAt === null || state.lastSynced > newLastSyncedAt) {
          newLastSyncedAt = state.lastSynced;
        }
      }
    }

    // Update the project-level lastSyncedAt
    if (newLastSyncedAt !== null) {
      this.lastSyncedAtPerProject[projectId] = newLastSyncedAt;
    }

    // Emit status change immediately (in-memory map is now updated)
    this.emitStatusChange(projectId);

    // Chain persist operation — enqueue it to the queue
    // This ensures writes land in call order and a failed persist doesn't wedge the queue
    this.persistQueue = this.persistQueue.then(
      () => this.persistSync(projectId),
      () => {
        // Previous persist failed, but continue anyway
        return this.persistSync(projectId);
      }
    );

    // Wait for this persist to complete before returning
    await this.persistQueue;
  }

  /**
   * Update a single document's state with status and fileId.
   * Common pattern for sync operations.
   */
  async updateDocument(
    projectId: string,
    docKey: string,
    updates: Partial<DocumentSyncState>
  ): Promise<void> {
    return this.update(projectId, (states) => {
      if (!states[docKey]) {
        states[docKey] = {
          driveFileId: null,
          lastSynced: null,
          status: 'pending',
        };
      }
      Object.assign(states[docKey], updates);
    });
  }

  /**
   * Mark a document as syncing.
   */
  async setSyncing(projectId: string, docKey: string): Promise<void> {
    return this.update(projectId, (states) => {
      if (!states[docKey]) {
        states[docKey] = {
          driveFileId: null,
          lastSynced: null,
          status: 'syncing',
        };
      } else {
        states[docKey].status = 'syncing';
      }
    });
  }

  /**
   * Mark a document as synced with fileId and lastSynced timestamp.
   */
  async setSynced(
    projectId: string,
    docKey: string,
    driveFileId: string,
    conflicts?: unknown[]
  ): Promise<void> {
    return this.update(projectId, (states) => {
      states[docKey] = {
        driveFileId,
        lastSynced: Date.now(),
        status: 'synced',
        conflicts: conflicts && conflicts.length > 0 ? conflicts : undefined,
      };
    });
  }

  /**
   * Mark a document as errored.
   */
  async setError(projectId: string, docKey: string, error: Error): Promise<void> {
    return this.update(projectId, (states) => {
      if (!states[docKey]) {
        states[docKey] = {
          driveFileId: null,
          lastSynced: null,
          status: 'error',
        };
      } else {
        states[docKey].status = 'error';
      }
      states[docKey].error = error;
    });
  }

  /**
   * Forget (delete) sync state for a document.
   * Used when an app removes a document from its set (e.g., deletes a filter rule).
   * Decision 32: the package never infers deletion from a document vanishing.
   */
  async forgetDocument(projectId: string, docKey: string): Promise<void> {
    return this.update(projectId, (states) => {
      delete states[docKey];
    });
  }

  /**
   * Persist sync state to storage.
   * Only persists 'synced' states, never transient 'syncing'.
   * A failed persist must not wedge the queue (called via promise chain).
   */
  private async persistSync(projectId: string): Promise<void> {
    try {
      const db = await this.getDb();
      const states = this.map[projectId];

      if (!states) return;

      // Filter: only persist 'synced' states
      const persistedStates: Record<string, DocumentSyncState> = {};
      for (const [docKey, state] of Object.entries(states)) {
        if (state.status === 'synced') {
          // Strip transient fields: don't persist error or conflicts
          persistedStates[docKey] = {
            driveFileId: state.driveFileId,
            lastSynced: state.lastSynced,
            status: 'synced',
          };
        }
      }

      // Only persist if there are synced states; don't create an entry for empty synced sets
      if (Object.keys(persistedStates).length === 0) {
        // No synced states to persist; remove the entry if it exists
        await db.delete('_syncStates', projectId);
        return;
      }

      // Persist to registry db under _syncStates store
      await db.put('_syncStates', {
        projectId,
        states: persistedStates,
        lastSyncedAt: this.lastSyncedAtPerProject[projectId] || null,
      });
    } catch (err) {
      // Log the error but do not rethrow — the queue must continue
      console.error(
        `Failed to persist sync state for project ${projectId}: ${err instanceof Error ? err.message : err}`
      );
      // The caller will not see this error; the queue continues
    }
  }

  /**
   * Get the last synced timestamp across all documents in a project.
   */
  getLastSyncedAt(projectId: string): number | null {
    return this.lastSyncedAtPerProject[projectId] || null;
  }

  /**
   * Get the overall sync phase for a project.
   * Derived from the statuses of all documents.
   */
  getSyncPhase(projectId: string): 'idle' | 'syncing' | 'error' {
    const projectStates = this.map[projectId];
    if (!projectStates) return 'idle';

    const states = Object.values(projectStates);
    if (states.some((s) => s.status === 'error')) return 'error';
    if (states.some((s) => s.status === 'syncing')) return 'syncing';
    return 'idle';
  }

  /**
   * Subscribe to sync status changes.
   * Returns an unsubscribe function.
   */
  subscribe(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback);
    return () => {
      this.statusCallbacks.delete(callback);
    };
  }

  /**
   * Emit status change to all subscribers.
   */
  private emitStatusChange(projectId: string): void {
    const phase = this.getSyncPhase(projectId);
    const lastSyncedAt = this.getLastSyncedAt(projectId);

    const status: SyncStatus = {
      phase,
      lastSyncedAt,
      error: null,
      needsReauth: false,
      conflicts: [],
    };

    // Collect all conflicts from the project's documents
    const projectStates = this.map[projectId];
    if (projectStates) {
      for (const state of Object.values(projectStates)) {
        if (state.error) {
          status.error = state.error;
          break;
        }
        if (state.conflicts && state.conflicts.length > 0) {
          status.conflicts = status.conflicts.concat(state.conflicts);
        }
      }
    }

    for (const callback of this.statusCallbacks) {
      callback(status);
    }
  }

  /**
   * Clear all state for a project (e.g., on project deletion).
   */
  async clearProject(projectId: string): Promise<void> {
    return this.update(projectId, (states) => {
      // Clear all documents in this project
      for (const key of Object.keys(states)) {
        delete states[key];
      }
    });
  }
}
