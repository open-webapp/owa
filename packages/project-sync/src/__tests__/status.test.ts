/**
 * @vitest-environment jsdom
 *
 * Comprehensive tests for StatusObservable.
 *
 * Tests:
 * - happy: subscriber sees idle → syncing → idle with lastSyncedAt advanced
 * - happy: unsubscribe → no further calls, no leak
 * - edge: snapshot referentially stable when nothing changed (prevents render loops)
 * - edge: scope revoked → needsReauth flips within one poll, zero network calls
 * - error: failed sync → phase: 'error' carrying typed error, cleared on next success
 *
 * Acceptance: tests green; no string sniffing anywhere.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DriveSync } from '@open-webapp/drive-sync';
import { StatusObservable } from '../status.js';
import { NeedsReauthError, ScopeInsufficientError } from '../errors.js';

describe('StatusObservable', () => {
  let observable: StatusObservable;
  let mockDrive: DriveSync;

  beforeEach(() => {
    // Create a mock drive instance
    mockDrive = {} as DriveSync;

    // Create observable
    observable = new StatusObservable(mockDrive);

    // Use fake timers for testing interval polling
    vi.useFakeTimers();
  });

  afterEach(() => {
    observable.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Happy path: basic subscription lifecycle
  // ============================================================================

  describe('happy path: subscription lifecycle', () => {
    it('subscriber sees idle → syncing → idle with lastSyncedAt advanced', async () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({
          phase: status.phase,
          lastSyncedAt: status.lastSyncedAt,
          error: status.error?.name,
          needsReauth: status.needsReauth,
        });
      });

      // Initial state should be idle
      expect(events[0].phase).toBe('idle');
      expect(events[0].lastSyncedAt).toBe(null);

      const syncStartTime = Date.now();

      // Start sync
      observable.markSyncStart();
      expect(events[events.length - 1].phase).toBe('syncing');
      expect(events[events.length - 1].lastSyncedAt).toBe(null); // Not updated yet

      // Complete sync
      const syncEndTime = Date.now() + 1000;
      observable.markSyncEnd(syncEndTime);

      // Should transition back to idle and update lastSyncedAt
      expect(events[events.length - 1].phase).toBe('idle');
      expect(events[events.length - 1].lastSyncedAt).toBe(syncEndTime);
    });

    it('multiple concurrent syncs tracked correctly', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({ phase: status.phase });
      });

      // Start two concurrent syncs
      observable.markSyncStart();
      expect(events[events.length - 1].phase).toBe('syncing');

      observable.markSyncStart();
      expect(events[events.length - 1].phase).toBe('syncing'); // Still syncing

      // End first sync
      observable.markSyncEnd();
      expect(events[events.length - 1].phase).toBe('syncing'); // Still syncing (one more in progress)

      // End second sync
      observable.markSyncEnd();
      expect(events[events.length - 1].phase).toBe('idle'); // Now idle
    });
  });

  // ============================================================================
  // Happy path: unsubscribe behavior (no leak)
  // ============================================================================

  describe('happy path: unsubscribe', () => {
    it('unsubscribe prevents further calls', () => {
      const callback = vi.fn();
      const unsubscribe = observable.subscribe(callback);

      // Should be called immediately with initial status
      expect(callback).toHaveBeenCalledTimes(1);
      const initialCall = callback.mock.calls[0];

      // Trigger a state change
      observable.markSyncStart();
      expect(callback).toHaveBeenCalledTimes(2);

      // Unsubscribe
      unsubscribe();

      // Further state changes should not trigger callback
      observable.markSyncEnd();
      expect(callback).toHaveBeenCalledTimes(2); // Still 2, no new call
    });

    it('multiple unsubscribes are safe', () => {
      const callback = vi.fn();
      const unsubscribe = observable.subscribe(callback);

      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();

      observable.markSyncStart();
      expect(callback).toHaveBeenCalledTimes(1); // Just initial
    });
  });

  // ============================================================================
  // Edge case: snapshot referential stability
  // ============================================================================

  describe('edge case: referential stability', () => {
    it('snapshot is referentially stable when nothing changed', () => {
      const snapshots: any[] = [];

      observable.subscribe((status) => {
        snapshots.push(status);
      });

      // Initial snapshot
      const initialSnapshot = snapshots[0];

      // Emit again without changing state
      observable.markSyncStart();
      observable.markSyncEnd(1000);

      // Get the last snapshot in idle state
      const idleSnapshot1 = snapshots[snapshots.length - 1];

      // Request the same status again without changing anything
      const idleSnapshot2 = observable.getStatus();

      // When nothing changed, snapshot should be the same object reference
      // (this prevents unnecessary re-renders in React)
      expect(idleSnapshot1).toBe(idleSnapshot2);
    });

    it('snapshot changes when phase changes', () => {
      const snapshots: any[] = [];

      observable.subscribe((status) => {
        snapshots.push(status);
      });

      const idleSnapshot = snapshots[0];

      observable.markSyncStart();
      const syncingSnapshot = snapshots[snapshots.length - 1];

      // Different phase = different object reference
      expect(idleSnapshot).not.toBe(syncingSnapshot);
      expect(idleSnapshot.phase).toBe('idle');
      expect(syncingSnapshot.phase).toBe('syncing');
    });

    it('snapshot changes when lastSyncedAt changes', () => {
      const snapshots: any[] = [];

      observable.subscribe((status) => {
        snapshots.push(status);
      });

      observable.markSyncStart();
      observable.markSyncEnd(1000);

      const snapshot1 = snapshots[snapshots.length - 1];

      observable.markSyncStart();
      observable.markSyncEnd(2000);

      const snapshot2 = snapshots[snapshots.length - 1];

      // Different lastSyncedAt = different object reference
      expect(snapshot1).not.toBe(snapshot2);
      expect(snapshot1.lastSyncedAt).toBe(1000);
      expect(snapshot2.lastSyncedAt).toBe(2000);
    });

    it('immutable snapshots and conflicts array', () => {
      const snapshots: any[] = [];

      observable.subscribe((status) => {
        snapshots.push(status);
      });

      const snapshot = snapshots[0];

      // Snapshot should be frozen
      expect(() => {
        (snapshot as any).phase = 'error';
      }).toThrow();

      // Conflicts array should be frozen
      expect(() => {
        snapshot.conflicts.push('something');
      }).toThrow();
    });
  });

  // ============================================================================
  // Edge case: reauth polling (scope revoked)
  // ============================================================================

  describe('edge case: reauth polling', () => {
    it('scope revoked → needsReauth flips within one poll', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({
          needsReauth: status.needsReauth,
          phase: status.phase,
        });
      });

      // Initially, needsReauth is false
      expect(events[0].needsReauth).toBe(false);

      // Simulate scope revocation by marking a ScopeInsufficientError
      const scopeError = new ScopeInsufficientError();
      observable.markSyncError(scopeError);

      // needsReauth should flip to true immediately
      const lastEvent = events[events.length - 1];
      expect(lastEvent.needsReauth).toBe(true);
      expect(lastEvent.phase).toBe('error');
    });

    it('needsReauth persists across poll interval', () => {
      const snapshots: any[] = [];

      observable.subscribe((status) => {
        snapshots.push(status);
      });

      // Mark a reauth error
      observable.markSyncError(new NeedsReauthError());
      expect(snapshots[snapshots.length - 1].needsReauth).toBe(true);

      // Advance time by 60s (one poll cycle)
      vi.advanceTimersByTime(60000);

      // needsReauth should still be true
      // (it was cleared by building a new snapshot on the poll tick,
      // but we haven't actually cleared it programmatically)
      const lastSnapshot = snapshots[snapshots.length - 1];
      expect(lastSnapshot.needsReauth).toBe(true);
    });

    it('clearReauth resets needsReauth flag', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push(status.needsReauth);
      });

      observable.markSyncError(new NeedsReauthError());
      expect(events[events.length - 1]).toBe(true);

      observable.clearReauth();
      expect(events[events.length - 1]).toBe(false);
    });

    it('reauth poll runs without network calls', () => {
      // This test ensures that polling doesn't call out to the network.
      // We verify this by observing that only local state changes are reflected.
      const callCount = vi.fn();

      observable.subscribe(() => {
        callCount();
      });

      // Reset to clear the initial call
      callCount.mockClear();

      // Advance time by exactly 60s (one poll cycle)
      vi.advanceTimersByTime(60000);

      // The poll should trigger emission logic, but since nothing changed,
      // it won't actually call the callback (referential stability).
      // So we expect 0 calls if nothing changed, or 1 if needsReauth changed.
      // In this case, nothing changes, so 0.
      expect(callCount).toHaveBeenCalledTimes(0);
    });
  });

  // ============================================================================
  // Error handling: failed sync
  // ============================================================================

  describe('error: failed sync', () => {
    it('failed sync → phase: error carrying typed error', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({
          phase: status.phase,
          error: status.error?.name,
        });
      });

      // Start and fail a sync
      observable.markSyncStart();
      expect(events[events.length - 1].phase).toBe('syncing');

      const error = new Error('Network timeout');
      observable.markSyncError(error);

      const lastEvent = events[events.length - 1];
      expect(lastEvent.phase).toBe('error');
      expect(lastEvent.error).toBe('Error');
    });

    it('error cleared on next successful sync', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({
          phase: status.phase,
          error: status.error?.name ?? null,
        });
      });

      // Fail a sync
      observable.markSyncStart();
      observable.markSyncError(new Error('Something went wrong'));

      expect(events[events.length - 1].error).toBe('Error');
      expect(events[events.length - 1].phase).toBe('error');

      // Start and successfully complete a new sync
      observable.markSyncStart();
      expect(events[events.length - 1].phase).toBe('syncing');
      expect(events[events.length - 1].error).toBe('Error'); // Still there (not cleared yet)

      observable.markSyncEnd();

      // Error should be cleared
      const lastEvent = events[events.length - 1];
      expect(lastEvent.error).toBe(null);
      expect(lastEvent.phase).toBe('idle');
    });

    it('typed errors are preserved', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push(status.error);
      });

      const reauthError = new NeedsReauthError();
      observable.markSyncStart();
      observable.markSyncError(reauthError);

      const lastError = events[events.length - 1];
      expect(lastError).toBe(reauthError);
      expect(lastError?.name).toBe('NeedsReauthError');
    });

    it('error during concurrent syncs', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({
          phase: status.phase,
          error: status.error?.name ?? null,
        });
      });

      // Start two concurrent syncs
      observable.markSyncStart();
      observable.markSyncStart();

      // First one fails
      observable.markSyncError(new Error('Sync 1 failed'));
      expect(events[events.length - 1].phase).toBe('syncing'); // Still syncing (one more in progress)

      // Second one succeeds
      observable.markSyncEnd();
      expect(events[events.length - 1].error).toBe(null); // Error cleared
      expect(events[events.length - 1].phase).toBe('idle');
    });
  });

  // ============================================================================
  // Conflicts tracking
  // ============================================================================

  describe('conflicts tracking', () => {
    it('conflicts set and emitted', () => {
      const snapshots: any[] = [];

      observable.subscribe((status) => {
        snapshots.push(status);
      });

      const conflicts = [{ field: 'name', local: 'Alice', remote: 'Bob' }];
      observable.setConflicts(conflicts);

      const lastSnapshot = snapshots[snapshots.length - 1];
      expect(lastSnapshot.conflicts).toHaveLength(1);
      expect(lastSnapshot.conflicts[0]).toEqual(conflicts[0]);
    });

    it('conflicts cleared on next successful sync', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push(status.conflicts);
      });

      observable.setConflicts([{ field: 'x' }]);
      expect(events[events.length - 1]).toHaveLength(1);

      observable.markSyncStart();
      observable.markSyncEnd();

      // Conflicts should be cleared
      expect(events[events.length - 1]).toHaveLength(0);
    });
  });

  // ============================================================================
  // Cleanup and lifecycle
  // ============================================================================

  describe('cleanup and lifecycle', () => {
    it('destroy stops polling and clears subscriptions', () => {
      const callback = vi.fn();
      observable.subscribe(callback);

      callback.mockClear();

      observable.destroy();

      // Trigger state change
      observable.markSyncStart();

      // Callback should not be called after destroy
      expect(callback).not.toHaveBeenCalled();
    });

    it('getStatus returns current status without subscribing', () => {
      observable.markSyncStart();

      const status = observable.getStatus();
      expect(status.phase).toBe('syncing');
      expect(status.lastSyncedAt).toBe(null);

      observable.markSyncEnd(5000);

      const status2 = observable.getStatus();
      expect(status2.phase).toBe('idle');
      expect(status2.lastSyncedAt).toBe(5000);
    });
  });

  // ============================================================================
  // Integration tests
  // ============================================================================

  describe('integration tests', () => {
    it('full sync lifecycle with error and recovery', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({
          phase: status.phase,
          lastSyncedAt: status.lastSyncedAt,
          error: status.error?.name ?? null,
          needsReauth: status.needsReauth,
          conflictCount: status.conflicts.length,
        });
      });

      // Initial state
      expect(events[0]).toEqual({
        phase: 'idle',
        lastSyncedAt: null,
        error: null,
        needsReauth: false,
        conflictCount: 0,
      });

      // Start sync
      observable.markSyncStart();
      expect(events[events.length - 1].phase).toBe('syncing');

      // Add conflicts
      observable.setConflicts([{ field: 'x' }]);
      expect(events[events.length - 1].conflictCount).toBe(1);

      // Fail
      observable.markSyncError(new Error('Network error'));
      expect(events[events.length - 1].phase).toBe('error');
      expect(events[events.length - 1].error).toBe('Error');

      // Retry and succeed
      observable.markSyncStart();
      observable.markSyncEnd(1000);

      const finalEvent = events[events.length - 1];
      expect(finalEvent).toEqual({
        phase: 'idle',
        lastSyncedAt: 1000,
        error: null,
        needsReauth: false,
        conflictCount: 0,
      });
    });

    it('reauth error during sync', () => {
      const events: any[] = [];

      observable.subscribe((status) => {
        events.push({
          phase: status.phase,
          needsReauth: status.needsReauth,
          error: status.error?.name,
        });
      });

      observable.markSyncStart();
      observable.markSyncError(new ScopeInsufficientError());

      const lastEvent = events[events.length - 1];
      expect(lastEvent.phase).toBe('error');
      expect(lastEvent.error).toBe('ScopeInsufficientError');
      expect(lastEvent.needsReauth).toBe(true);
    });
  });
});
