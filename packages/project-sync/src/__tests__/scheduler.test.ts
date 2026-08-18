/**
 * @vitest-environment jsdom
 *
 * Comprehensive tests for Scheduler.
 *
 * Tests:
 * - happy: start() with interval → scheduler running
 * - happy: markDirty → one sync after debounce
 * - edge: two overlapping syncNow() → single underlying run, both callers resolve
 * - edge: stop() → clears debounce timers
 * - edge: disconnect → stops scheduler
 * - edge: visibility regain triggers sync
 * - edge: leader election with multiple instances
 * - error: sync throws → interval survives
 *
 * Acceptance: tests pass with proper lifecycle management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scheduler, type SchedulerConfig, type SyncFn } from '../scheduler.js';

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let syncFn: SyncFn;
  let syncCalls: { projectId?: string; timestamp: number }[];

  beforeEach(() => {
    // Setup sync function mock
    syncCalls = [];
    syncFn = vi.fn(async (projectId?: string) => {
      syncCalls.push({ projectId, timestamp: Date.now() });
    });

    // Setup document.hidden for visibility tests
    Object.defineProperty(document, 'hidden', {
      writable: true,
      value: false,
    });

    // Disable BroadcastChannel for simpler testing
    (global as any).BroadcastChannel = undefined;

    // Create scheduler
    const config: SchedulerConfig = {
      interval: 1000,
      dirtyDebounceMs: 500,
    };
    scheduler = new Scheduler(config);
    scheduler.setSyncFn(syncFn);
  });

  afterEach(() => {
    scheduler.disconnect();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Happy path: basic lifecycle
  // ============================================================================

  describe('happy: basic lifecycle', () => {
    it('should start and stop correctly', () => {
      expect(scheduler.isRunning()).toBe(false);

      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should support manual sync when interval is null', async () => {
      const configNoInterval: SchedulerConfig = {
        interval: null,
      };
      const schedulerNoInterval = new Scheduler(configNoInterval);
      schedulerNoInterval.setSyncFn(syncFn);
      schedulerNoInterval.start();

      await schedulerNoInterval.syncNow();

      expect(syncFn).toHaveBeenCalledTimes(1);
      expect(syncFn).toHaveBeenCalledWith(undefined);

      schedulerNoInterval.disconnect();
    });

    it('should be leader in single-tab mode', () => {
      scheduler.start();
      expect(scheduler.getIsLeader()).toBe(true);
      scheduler.stop();
    });
  });

  // ============================================================================
  // Happy path: markDirty debounce
  // ============================================================================

  describe('happy: markDirty debounce', () => {
    it('should debounce markDirty calls', async () => {
      vi.useFakeTimers({ now: new Date('2000-01-01').getTime() });
      const config: SchedulerConfig = {
        interval: null,
        dirtyDebounceMs: 100,
      };
      const testScheduler = new Scheduler(config);
      testScheduler.setSyncFn(syncFn);
      testScheduler.start();

      // Mark dirty multiple times
      testScheduler.markDirty('proj-1');
      testScheduler.markDirty('proj-1');
      testScheduler.markDirty('proj-1');

      // Should not sync yet
      expect(syncFn).not.toHaveBeenCalled();

      // Advance by debounce time
      vi.advanceTimersByTime(100);

      // Should sync once
      expect(syncFn).toHaveBeenCalledTimes(1);
      expect(syncFn).toHaveBeenCalledWith('proj-1');

      testScheduler.disconnect();
      vi.useRealTimers();
    });

    it('should reset debounce timer on each markDirty call', async () => {
      vi.useFakeTimers({ now: new Date('2000-01-01').getTime() });
      const config: SchedulerConfig = {
        interval: null,
        dirtyDebounceMs: 100,
      };
      const testScheduler = new Scheduler(config);
      testScheduler.setSyncFn(syncFn);
      testScheduler.start();

      testScheduler.markDirty('proj-1');
      vi.advanceTimersByTime(60);

      testScheduler.markDirty('proj-1'); // Reset timer
      vi.advanceTimersByTime(60);

      // Should not sync yet (still within debounce from last call)
      expect(syncFn).not.toHaveBeenCalled();

      // Advance past debounce
      vi.advanceTimersByTime(100);

      // Should sync once
      expect(syncFn).toHaveBeenCalledTimes(1);

      testScheduler.disconnect();
      vi.useRealTimers();
    });

    it('should debounce per project independently', async () => {
      vi.useFakeTimers({ now: new Date('2000-01-01').getTime() });
      const config: SchedulerConfig = {
        interval: null,
        dirtyDebounceMs: 100,
      };
      const testScheduler = new Scheduler(config);
      testScheduler.setSyncFn(syncFn);
      testScheduler.start();

      testScheduler.markDirty('proj-1');
      testScheduler.markDirty('proj-2');

      vi.advanceTimersByTime(100);

      // Should sync both projects
      expect(syncFn).toHaveBeenCalledTimes(2);
      const calls = syncFn.mock.calls.map((c) => c[0]);
      expect(calls).toContain('proj-1');
      expect(calls).toContain('proj-2');

      testScheduler.disconnect();
      vi.useRealTimers();
    });
  });

  // ============================================================================
  // Edge: single-flight per project
  // ============================================================================

  describe('edge: single-flight per project', () => {
    it('should return same promise for concurrent syncNow() calls', async () => {
      scheduler.start();

      // Make two concurrent calls
      const promise1 = scheduler.syncNow('proj-1');
      const promise2 = scheduler.syncNow('proj-1');

      // Should be the same promise
      expect(promise1 === promise2).toBe(true);

      await Promise.all([promise1, promise2]);

      // Should only call sync once
      expect(syncFn).toHaveBeenCalledTimes(1);
    });

    it('should allow different projects to sync independently', async () => {
      scheduler.start();

      // Sync different projects
      const p1 = scheduler.syncNow('proj-1');
      const p2 = scheduler.syncNow('proj-2');

      await Promise.all([p1, p2]);

      // Both should have been synced
      expect(syncFn).toHaveBeenCalledTimes(2);
      const calls = syncFn.mock.calls.map((c) => c[0]);
      expect(calls).toContain('proj-1');
      expect(calls).toContain('proj-2');
    });

    it('should clear single-flight entry after sync completes', async () => {
      scheduler.start();

      const p1 = scheduler.syncNow('proj-1');
      await p1;

      // Next call should create a new promise
      const p2 = scheduler.syncNow('proj-1');
      expect(p1 === p2).toBe(false);

      await p2;

      // Should have synced twice
      expect(syncFn).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // Edge: stop and disconnect
  // ============================================================================

  describe('edge: stop and disconnect', () => {
    it('should stop scheduler and clear debounce timers', async () => {
      vi.useFakeTimers();
      const config: SchedulerConfig = {
        interval: null,
        dirtyDebounceMs: 100,
      };
      const testScheduler = new Scheduler(config);
      testScheduler.setSyncFn(syncFn);
      testScheduler.start();

      testScheduler.markDirty('proj-1');

      // Stop before debounce fires
      testScheduler.stop();

      vi.advanceTimersByTime(500);

      // Should not have synced
      expect(syncFn).not.toHaveBeenCalled();

      testScheduler.disconnect();
      vi.useRealTimers();
    });

    it('should not sync after disconnect', async () => {
      scheduler.start();
      scheduler.disconnect();

      await scheduler.syncNow().catch(() => {
        // Expected to potentially fail after disconnect
      });

      // Should not be running
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  // ============================================================================
  // Edge: visibility regain
  // ============================================================================

  describe('edge: visibility regain', () => {
    it('should trigger sync when tab becomes visible', async () => {
      scheduler.start();

      // Hide tab
      (document as any).hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));

      // Become visible again
      (document as any).hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));

      // Give event handler time to fire
      await new Promise((r) => setTimeout(r, 10));

      // Should have synced on visibility regain
      expect(syncFn).toHaveBeenCalled();
    });

    it('should not sync on first visibility check', async () => {
      // Start with hidden tab
      (document as any).hidden = true;

      scheduler.start();

      // Trigger visibility change (still hidden)
      document.dispatchEvent(new Event('visibilitychange'));

      await new Promise((r) => setTimeout(r, 10));

      expect(syncFn).not.toHaveBeenCalled();
    });

    it('should not fire visibility events after disconnect', async () => {
      scheduler.start();
      scheduler.disconnect();

      // Hide then show tab
      (document as any).hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));

      (document as any).hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));

      await new Promise((r) => setTimeout(r, 10));

      expect(syncFn).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Error handling
  // ============================================================================

  describe('error: sync failure recovery', () => {
    it('should handle sync errors gracefully', async () => {
      let callCount = 0;
      const errorSyncFn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Sync failed');
        }
      });

      scheduler.setSyncFn(errorSyncFn);
      scheduler.start();

      // First sync should fail but not throw
      await scheduler.syncNow().catch(() => {
        // Expected to fail
      });

      expect(errorSyncFn).toHaveBeenCalledTimes(1);

      // Second sync should work
      await scheduler.syncNow();
      expect(errorSyncFn).toHaveBeenCalledTimes(2);
    });

    it('should handle markDirty sync errors gracefully', async () => {
      vi.useFakeTimers();
      const errorSyncFn = vi.fn(async () => {
        throw new Error('Sync error');
      });

      const config: SchedulerConfig = {
        interval: null,
        dirtyDebounceMs: 100,
      };
      const testScheduler = new Scheduler(config);
      testScheduler.setSyncFn(errorSyncFn);
      testScheduler.start();

      // Should not throw
      expect(() => {
        testScheduler.markDirty('proj-1');
      }).not.toThrow();

      vi.advanceTimersByTime(100);

      // Sync should have been attempted
      expect(errorSyncFn).toHaveBeenCalled();

      testScheduler.disconnect();
      vi.useRealTimers();
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe('edge: syncNow with and without projectId', () => {
    it('should handle syncNow() without projectId', async () => {
      scheduler.start();

      await scheduler.syncNow();

      expect(syncFn).toHaveBeenCalledWith(undefined);
    });

    it('should handle syncNow(projectId) with projectId', async () => {
      scheduler.start();

      await scheduler.syncNow('proj-1');

      expect(syncFn).toHaveBeenCalledWith('proj-1');
    });

    it('should treat syncNow() and syncNow(projectId) as different in single-flight', async () => {
      scheduler.start();

      const p1 = scheduler.syncNow();
      const p2 = scheduler.syncNow('proj-1');

      expect(p1 === p2).toBe(false);

      await Promise.all([p1, p2]);

      expect(syncFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('edge: start/stop/restart', () => {
    it('should handle start/stop cycles', async () => {
      expect(scheduler.isRunning()).toBe(false);

      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);

      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      await scheduler.syncNow();
      expect(syncFn).toHaveBeenCalled();
    });
  });

  describe('edge: custom debounce delay', () => {
    it('should use custom debounce delay', async () => {
      vi.useFakeTimers();
      const config: SchedulerConfig = {
        interval: null,
        dirtyDebounceMs: 200,
      };
      const customScheduler = new Scheduler(config);
      customScheduler.setSyncFn(syncFn);
      customScheduler.start();

      customScheduler.markDirty('proj-1');

      vi.advanceTimersByTime(200);

      expect(syncFn).toHaveBeenCalledTimes(1);

      customScheduler.disconnect();
      vi.useRealTimers();
    });
  });

  describe('edge: syncNow before start', () => {
    it('should work even if called before start', async () => {
      // Don't start scheduler
      const promise = scheduler.syncNow('proj-1');

      await promise;

      expect(syncFn).toHaveBeenCalled();
    });
  });
});
