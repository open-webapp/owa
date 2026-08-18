/**
 * Sync status observable — immutable snapshots safe for useSyncExternalStore.
 *
 * Emits { phase, lastSyncedAt, error, needsReauth, conflicts } with:
 * - Referentially stable snapshots when nothing changed (prevents render loops)
 * - needsReauth polled locally every 60s (no network calls)
 * - Error cleared on next successful sync
 * - Immutable snapshots for safe external store subscription
 *
 * Implements decision 14 (status observable and reauth poll).
 */

import type { DriveSync } from '@open-webapp/drive-sync';
import type { SyncStatus, SyncPhase } from './types.js';

/**
 * Callback for status changes.
 */
export type StatusCallback = (status: SyncStatus) => void;

/**
 * Reauth checker that polls the connection status locally without network.
 */
interface ReauthChecker {
  check(): boolean; // Returns true if reauth is needed
}

/**
 * Local reauth checker that maintains an in-memory flag.
 * The flag is set by the sync engine when it encounters NeedsReauthError,
 * and can be reset when the user reconnects.
 */
class LocalReauthChecker implements ReauthChecker {
  private needsReauth = false;

  setNeedsReauth(needs: boolean): void {
    this.needsReauth = needs;
  }

  check(): boolean {
    return this.needsReauth;
  }
}

/**
 * Status observable with subscription-based emission.
 * Maintains the current sync state and notifies subscribers of changes.
 */
export class StatusObservable {
  private callbacks: Set<StatusCallback> = new Set();
  private currentStatus: SyncStatus;
  private lastSnapshot: SyncStatus | null = null;
  private reauthChecker: LocalReauthChecker;
  private reauthPollInterval: ReturnType<typeof setInterval> | null = null;
  private drive: DriveSync;

  // Phase tracking
  private phase: SyncPhase = 'idle';
  private syncInProgress = 0; // Count of concurrent syncs
  private lastError: Error | null = null;
  private lastConflicts: unknown[] = [];
  private lastSyncedAt: number | null = null;

  constructor(drive: DriveSync) {
    this.drive = drive;
    this.reauthChecker = new LocalReauthChecker();

    // Initialize status snapshot
    this.currentStatus = this.buildSnapshot();

    // Start reauth polling
    this.startReauthPoll();
  }

  /**
   * Subscribe to status changes.
   * Returns an unsubscribe function (no leak on cleanup).
   */
  subscribe(callback: StatusCallback): () => void {
    this.callbacks.add(callback);

    // Immediately call with current status
    callback(this.currentStatus);

    // Return unsubscribe function
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Mark the start of a sync operation.
   * Increments the sync counter and updates phase to 'syncing'.
   */
  markSyncStart(): void {
    this.syncInProgress++;
    this.updatePhase('syncing');
  }

  /**
   * Mark the end of a sync operation (success).
   * Decrements the sync counter, updates lastSyncedAt, and clears error.
   */
  markSyncEnd(now: number = Date.now()): void {
    this.syncInProgress = Math.max(0, this.syncInProgress - 1);
    this.lastError = null;
    this.lastConflicts = [];
    this.lastSyncedAt = now;
    this.updatePhase(this.syncInProgress > 0 ? 'syncing' : 'idle');
  }

  /**
   * Mark a sync error.
   * Sets error and transitions to 'error' phase if no syncs in progress.
   */
  markSyncError(error: Error): void {
    this.lastError = error;

    // Check if this is a reauth error and mark it
    if (
      error.name === 'NeedsReauthError' ||
      error.name === 'ScopeInsufficientError' ||
      error.name === 'WrongAccountError'
    ) {
      this.reauthChecker.setNeedsReauth(true);
    }

    this.syncInProgress = Math.max(0, this.syncInProgress - 1);
    this.updatePhase(this.syncInProgress > 0 ? 'syncing' : 'error');
  }

  /**
   * Set conflicts for the current status.
   * Called after a merge that returns conflicts.
   */
  setConflicts(conflicts: unknown[]): void {
    this.lastConflicts = conflicts;
    this.emitIfChanged();
  }

  /**
   * Clear the reauth flag (called when user reconnects).
   */
  clearReauth(): void {
    this.reauthChecker.setNeedsReauth(false);
    this.emitIfChanged();
  }

  /**
   * Cleanup: stop polling and clear subscriptions.
   */
  destroy(): void {
    this.stopReauthPoll();
    this.callbacks.clear();
  }

  /**
   * Get the current status snapshot without subscribing.
   */
  getStatus(): SyncStatus {
    return this.currentStatus;
  }

  /**
   * =========================================================================
   * Private implementation
   * =========================================================================
   */

  private updatePhase(newPhase: SyncPhase): void {
    if (this.phase !== newPhase) {
      this.phase = newPhase;
      this.emitIfChanged();
    } else {
      this.emitIfChanged();
    }
  }

  /**
   * Build an immutable snapshot of the current status.
   * Reuses the previous snapshot if nothing changed (referential stability).
   */
  private buildSnapshot(): SyncStatus {
    const needsReauth = this.reauthChecker.check();

    const newSnapshot: SyncStatus = Object.freeze({
      phase: this.phase,
      lastSyncedAt: this.lastSyncedAt,
      error: this.lastError,
      needsReauth,
      conflicts: Object.freeze([...this.lastConflicts]) as unknown[],
    });

    // Check if snapshot actually changed by comparing all fields
    if (this.lastSnapshot) {
      const changed =
        this.lastSnapshot.phase !== newSnapshot.phase ||
        this.lastSnapshot.lastSyncedAt !== newSnapshot.lastSyncedAt ||
        this.lastSnapshot.error !== newSnapshot.error ||
        this.lastSnapshot.needsReauth !== newSnapshot.needsReauth ||
        this.lastSnapshot.conflicts.length !== newSnapshot.conflicts.length;

      if (!changed && this.lastSnapshot.conflicts.length > 0) {
        // Deep check conflicts
        for (let i = 0; i < newSnapshot.conflicts.length; i++) {
          if (this.lastSnapshot.conflicts[i] !== newSnapshot.conflicts[i]) {
            return newSnapshot; // Changed
          }
        }
        // Nothing changed, reuse old snapshot for referential stability
        return this.lastSnapshot;
      }
    }

    this.lastSnapshot = newSnapshot;
    return newSnapshot;
  }

  /**
   * Emit status only if it changed, maintaining referential stability.
   */
  private emitIfChanged(): void {
    const newSnapshot = this.buildSnapshot();

    // Referential check: if it's the same object, no change
    if (this.currentStatus === newSnapshot) {
      return;
    }

    this.currentStatus = newSnapshot;

    // Emit to all subscribers
    for (const callback of this.callbacks) {
      try {
        callback(newSnapshot);
      } catch (err) {
        // Swallow callback errors to prevent cascading failures
        console.error('Status callback error:', err);
      }
    }
  }

  /**
   * Start polling needsReauth locally every 60s.
   * No network calls; relies on sync errors setting the flag.
   */
  private startReauthPoll(): void {
    if (this.reauthPollInterval) {
      clearInterval(this.reauthPollInterval);
    }

    // Poll every 60s (60000ms)
    this.reauthPollInterval = setInterval(() => {
      // Just rebuild the snapshot to check if needsReauth changed
      this.emitIfChanged();
    }, 60000);
  }

  /**
   * Stop the reauth poll interval.
   */
  private stopReauthPoll(): void {
    if (this.reauthPollInterval) {
      clearInterval(this.reauthPollInterval);
      this.reauthPollInterval = null;
    }
  }
}
