/**
 * Migration marker plumbing for managing one-time startup operations.
 *
 * Implements decision 26 — the only migration code in the package.
 * Provides runOnce(key, fn) that skips if already marked, runs fn, and marks only on success.
 * Single-flight so two tabs racing at startup run it once.
 *
 * Persists markers in a migrations store within the registry database.
 */

import type { IDBPDatabase } from 'idb';
import { openDB } from 'idb';

/**
 * Manager for migration markers and execution.
 * Handles one-time setup operations with proper error handling and single-flight concurrency.
 */
export class MigrationsManager {
  private db: IDBPDatabase<any> | null = null;
  private dbName: string;

  /**
   * In-flight promises for single-flight behavior.
   * Maps migration key to the promise of that migration's execution.
   * This ensures two concurrent runOnce calls with the same key await the same result.
   */
  private inFlight = new Map<string, Promise<void>>();

  constructor(dbName: string) {
    this.dbName = dbName;
  }

  /**
   * Initialize the migrations manager database.
   * Sets up the migrations store if needed.
   * Call this once during app startup before running any migrations.
   */
  async init(): Promise<void> {
    this.db = await openDB(this.dbName, 1, {
      upgrade(db) {
        // Create the migrations store if it doesn't exist
        if (!db.objectStoreNames.contains('migrations')) {
          db.createObjectStore('migrations', { keyPath: 'key' });
        }
      },
    });
  }

  /**
   * Ensure database is initialized before operations.
   */
  private ensureDb(): IDBPDatabase<any> {
    if (!this.db) {
      throw new Error('MigrationsManager not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Check if a migration has been marked as run.
   * @param key - The migration key to check
   * @returns true if the migration has been marked as run, false otherwise
   */
  async hasRun(key: string): Promise<boolean> {
    const db = this.ensureDb();
    const record = await db.get('migrations', key);
    return record !== undefined;
  }

  /**
   * Mark a migration as run.
   * Stores a record with the key and timestamp.
   * @param key - The migration key to mark
   * @throws if the write to the database fails
   */
  async markRun(key: string): Promise<void> {
    const db = this.ensureDb();
    const record = {
      key,
      ranAt: new Date().toISOString(),
    };
    await db.put('migrations', record);
  }

  /**
   * Run a migration once, with single-flight concurrency.
   *
   * If the migration has already been marked as run, returns immediately.
   * Otherwise, executes fn() and marks as run only if fn() succeeds.
   * If fn() throws, the migration is NOT marked and will be retried on next boot.
   *
   * If two tabs/workers call runOnce with the same key concurrently,
   * fn will be invoked exactly once and both callers will await the same result.
   *
   * @param key - The migration key (must be unique per migration)
   * @param fn - The async function to execute once
   * @throws if fn throws, or if marking the migration as run fails
   */
  async runOnce(key: string, fn: () => Promise<void>): Promise<void> {
    // Check if already marked as run
    const already = await this.hasRun(key);
    if (already) {
      return;
    }

    // Single-flight: if this key is already in-flight, await that promise
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)!;
    }

    // Create a new in-flight promise
    const promise = this.executeOnce(key, fn);
    this.inFlight.set(key, promise);

    try {
      await promise;
    } finally {
      // Clean up the in-flight entry
      this.inFlight.delete(key);
    }
  }

  /**
   * Execute a migration and mark it as run on success.
   * This is the core logic for runOnce, separated so the in-flight promise
   * can be properly tracked and cleaned up.
   *
   * @param key - The migration key
   * @param fn - The migration function to run
   * @throws if fn throws or if marking as run fails
   */
  private async executeOnce(key: string, fn: () => Promise<void>): Promise<void> {
    // Execute the migration function
    // If it throws, this will propagate and the migration won't be marked
    await fn();

    // Only mark as run if fn succeeded
    // If this write fails, the error is surfaced to the caller
    // (not swallowed), so the migration will be retried next boot
    await this.markRun(key);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
