/**
 * Per-project data store lifecycle management.
 *
 * Manages IndexedDB handles for each project with:
 * - Deterministic dbName derivation from project id
 * - Handle caching and reuse (avoid reopening)
 * - Active project tracking
 * - Database deletion and cleanup
 * - IDB versionchange/blocked event handling
 * - App-supplied upgrade handler
 *
 * Decision 4: Package owns handle cache and lifecycle.
 * Only getActiveDb() exposes handles — never allows caller to obtain
 * a handle for a non-active project by accident.
 */

import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { openDB } from 'idb';

/**
 * App-supplied per-project database configuration.
 */
export interface DataStoreConfig {
  /** IndexedDB schema version */
  version: number;

  /**
   * Upgrade handler called when database opens if version changed.
   * Signature matches IDB's onupgradeneeded transaction.
   */
  upgrade(
    db: IDBPDatabase<any>,
    oldVersion: number,
    newVersion: number,
    tx: IDBPTransaction<any, any[], 'versionchange'>
  ): void | Promise<void>;
}

/**
 * Derive deterministic database name from project id.
 * Returns a stable, IndexedDB-safe name for the project's database.
 */
function deriveDbName(projectId: string): string {
  // Use a simple prefix with the project id
  // Project IDs already follow a stable pattern (p_<timestamp>_<random>)
  // so they're safe to use directly in db names
  return `project-data-${projectId}`;
}

/**
 * Internal state for a cached database handle.
 */
interface CachedHandle {
  db: IDBPDatabase<any>;
  config: DataStoreConfig;
}

/**
 * DataStore manages per-project IndexedDB lifecycle.
 * Coordinates active project tracking, handle caching, and cleanup.
 */
export class DataStore {
  // Track active project id (null if no active project)
  private activeProjectId: string | null = null;

  // Cache of opened database handles, keyed by project id
  private handleCache = new Map<string, CachedHandle>();

  /**
   * Set the active project and open its database.
   * If switching from another project, closes the previous handle (but keeps it cached).
   * Throws if the project id is invalid or database open fails.
   *
   * @param projectId - The project id to activate
   * @param config - App-supplied database configuration
   * @throws If database open fails or upgrade throws
   */
  async setActive(projectId: string, config: DataStoreConfig): Promise<void> {
    // Validate input
    if (!projectId || typeof projectId !== 'string') {
      throw new Error('Project id must be a non-empty string');
    }

    if (!config) {
      throw new Error('Config is required');
    }
    if (typeof config.upgrade !== 'function') {
      throw new Error('Config.upgrade must be a function');
    }
    if (typeof config.version !== 'number') {
      throw new Error('Config.version must be a number');
    }

    // Type-safe config after validation
    const validConfig: DataStoreConfig = config;

    // Get or open the database for this project
    let handle = this.handleCache.get(projectId);
    if (!handle) {
      // Open the database for the first time
      const dbName = deriveDbName(projectId);
      let db: IDBPDatabase<any> | null = null;
      try {
        db = await openDB(dbName, validConfig.version, {
          upgrade: async (db, oldVersion, newVersion, tx) => {
            await validConfig.upgrade(db, oldVersion, newVersion, tx);
          },
          blocked: () => {
            // Log but don't throw — another tab may have the db open
            // The versionchange event will fire when they close
            console.warn(`DataStore: version change blocked for ${dbName}`);
          },
          blocking: () => {
            // Log but don't throw — this tab is blocking another's version change
            console.warn(`DataStore: this tab is blocking version change for ${dbName}`);
          },
        });

        // Cache the handle only after successful open and upgrade
        handle = { db, config };
        this.handleCache.set(projectId, handle);
      } catch (error) {
        // If open fails (e.g., upgrade threw), don't cache anything
        // This ensures a half-created db won't be reused on retry
        // Also close the db if it was partially opened
        if (db) {
          db.close();
        }
        throw new Error(
          `Failed to open database for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Set as active
    this.activeProjectId = projectId;
  }

  /**
   * Get the active project's database handle.
   * Throws a clear error if no project is set active.
   *
   * @returns The active project's database handle
   * @throws If no project is currently active
   */
  getActiveDb(): IDBPDatabase<any> {
    if (!this.activeProjectId) {
      throw new Error(
        'No active project. Call setActive(projectId, config) to activate a project before accessing its database.'
      );
    }

    const handle = this.handleCache.get(this.activeProjectId);
    if (!handle) {
      // This should never happen if setActive succeeded, but be defensive
      throw new Error(`Active project ${this.activeProjectId} handle lost from cache`);
    }

    return handle.db;
  }

  /**
   * Get the currently active project id, or null if none.
   */
  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  /**
   * Delete a project's database and remove it from cache.
   * If the deleted project was active, clears the active pointer.
   *
   * @param projectId - The project id to delete
   */
  async deleteDatabase(projectId: string): Promise<void> {
    // Close the handle if cached
    const handle = this.handleCache.get(projectId);
    if (handle) {
      handle.db.close();
      this.handleCache.delete(projectId);
    }

    // If this was the active project, clear the active pointer
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
    }

    // Delete the underlying IndexedDB database
    const dbName = deriveDbName(projectId);
    try {
      // Use the idb library's deleteDB function
      // We need to access it from the module
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => {
          reject(new Error(`Failed to delete database ${dbName}: ${request.error?.message || 'unknown error'}`));
        };

        request.onblocked = () => {
          // Database deletion is blocked by another tab
          console.warn(`DataStore: deletion blocked for ${dbName} (another tab may have it open)`);
        };
      });
    } catch (error) {
      throw new Error(
        `Failed to delete database for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Close all cached database handles and clear the cache.
   * Does NOT delete the underlying databases (use deleteDatabase for that).
   * Clears the active project pointer.
   */
  closeAll(): void {
    for (const handle of this.handleCache.values()) {
      handle.db.close();
    }
    this.handleCache.clear();
    this.activeProjectId = null;
  }

  /**
   * Check if a project's database is currently cached (opened).
   * Used for testing and debugging.
   */
  isCached(projectId: string): boolean {
    return this.handleCache.has(projectId);
  }
}
