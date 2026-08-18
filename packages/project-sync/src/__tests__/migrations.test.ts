/**
 * Test suite for the MigrationsManager module.
 *
 * Uses fake-indexeddb to run tests without a real browser environment.
 * Tests single-flight behavior, error handling, and persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto'; // Auto-polyfill indexedDB
import { MigrationsManager } from '../migrations.js';

describe('MigrationsManager', () => {
  let manager: MigrationsManager;

  beforeEach(async () => {
    // Use a unique database name per test to avoid cross-test pollution
    const testDbName = `test-migrations-${Math.random().toString(36).substring(7)}`;
    manager = new MigrationsManager(testDbName);
    await manager.init();
  });

  afterEach(() => {
    manager.close();
  });

  describe('happy path: runOnce executes once', () => {
    it('should run fn once and mark as run', async () => {
      const fn = vi.fn(async () => {
        // noop
      });

      await manager.runOnce('test-key', fn);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(await manager.hasRun('test-key')).toBe(true);
    });

    it('should skip fn on second call', async () => {
      const fn = vi.fn(async () => {
        // noop
      });

      await manager.runOnce('test-key', fn);
      await manager.runOnce('test-key', fn);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(await manager.hasRun('test-key')).toBe(true);
    });

    it('should persist marker across manager instances', async () => {
      const fn1 = vi.fn(async () => {
        // noop
      });

      await manager.runOnce('persistent-key', fn1);

      // Create a new manager instance with the same database
      manager.close();
      const manager2 = new MigrationsManager(manager['dbName']);
      await manager2.init();

      const fn2 = vi.fn(async () => {
        // noop
      });

      await manager2.runOnce('persistent-key', fn2);

      // fn2 should never run because the marker was persisted
      expect(fn2).not.toHaveBeenCalled();
      expect(await manager2.hasRun('persistent-key')).toBe(true);

      manager2.close();
    });
  });

  describe('edge case: fn throws → not marked, retried next boot', () => {
    it('should not mark migration if fn throws', async () => {
      const error = new Error('Migration failed');
      const fn = vi.fn(async () => {
        throw error;
      });

      await expect(manager.runOnce('error-key', fn)).rejects.toThrow('Migration failed');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(await manager.hasRun('error-key')).toBe(false);
    });

    it('should retry a failed migration on second attempt', async () => {
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First attempt failed');
        }
      });

      // First attempt fails
      await expect(manager.runOnce('retry-key', fn)).rejects.toThrow('First attempt failed');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(await manager.hasRun('retry-key')).toBe(false);

      // Second attempt succeeds
      await manager.runOnce('retry-key', fn);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(await manager.hasRun('retry-key')).toBe(true);
    });

    it('should retry after closing and reopening the manager', async () => {
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Failed on first try');
        }
      });

      // First attempt fails
      await expect(manager.runOnce('retry-key', fn)).rejects.toThrow('Failed on first try');
      expect(await manager.hasRun('retry-key')).toBe(false);

      // Close and reopen manager
      manager.close();
      await manager.init();

      // Retry - should call fn again
      await manager.runOnce('retry-key', fn);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(await manager.hasRun('retry-key')).toBe(true);
    });
  });

  describe('edge case: concurrent runOnce with same key → single-flight', () => {
    it('should invoke fn exactly once when called concurrently with same key', async () => {
      const fn = vi.fn(async () => {
        // Simulate some async work
        await new Promise(r => setTimeout(r, 10));
      });

      // Call runOnce concurrently with the same key
      const [result1, result2, result3] = await Promise.all([
        manager.runOnce('concurrent-key', fn),
        manager.runOnce('concurrent-key', fn),
        manager.runOnce('concurrent-key', fn),
      ]);

      // fn should be called exactly once
      expect(fn).toHaveBeenCalledTimes(1);
      expect(await manager.hasRun('concurrent-key')).toBe(true);

      // All three callers should have completed
      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
      expect(result3).toBeUndefined();
    });

    it('should make concurrent callers await the same result when fn succeeds', async () => {
      const callOrder: string[] = [];
      const fn = vi.fn(async () => {
        callOrder.push('fn-start');
        await new Promise(r => setTimeout(r, 20));
        callOrder.push('fn-end');
      });

      const promises = [
        manager.runOnce('same-key', fn).then(() => callOrder.push('caller-1-done')),
        manager.runOnce('same-key', fn).then(() => callOrder.push('caller-2-done')),
        manager.runOnce('same-key', fn).then(() => callOrder.push('caller-3-done')),
      ];

      await Promise.all(promises);

      // fn should run exactly once
      expect(fn).toHaveBeenCalledTimes(1);

      // All callers should complete after fn completes
      expect(callOrder).toEqual(['fn-start', 'fn-end', 'caller-1-done', 'caller-2-done', 'caller-3-done']);
    });

    it('should propagate fn error to all concurrent callers', async () => {
      const error = new Error('Concurrent fn failed');
      const fn = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 10));
        throw error;
      });

      const results = await Promise.allSettled([
        manager.runOnce('error-key', fn),
        manager.runOnce('error-key', fn),
        manager.runOnce('error-key', fn),
      ]);

      // All three should reject with the same error
      results.forEach(result => {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason).toBe(error);
        }
      });

      // fn should be called exactly once
      expect(fn).toHaveBeenCalledTimes(1);

      // Migration should not be marked
      expect(await manager.hasRun('error-key')).toBe(false);
    });
  });

  describe('edge case: distinct keys are independent', () => {
    it('should execute independent migrations with different keys', async () => {
      const fn1 = vi.fn(async () => {
        // noop
      });
      const fn2 = vi.fn(async () => {
        // noop
      });
      const fn3 = vi.fn(async () => {
        // noop
      });

      await manager.runOnce('key-1', fn1);
      await manager.runOnce('key-2', fn2);
      await manager.runOnce('key-3', fn3);

      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(fn3).toHaveBeenCalledTimes(1);

      expect(await manager.hasRun('key-1')).toBe(true);
      expect(await manager.hasRun('key-2')).toBe(true);
      expect(await manager.hasRun('key-3')).toBe(true);
    });

    it('should skip second call only for the specific key', async () => {
      const fn1 = vi.fn(async () => {
        // noop
      });
      const fn2 = vi.fn(async () => {
        // noop
      });

      // Run first migration twice
      await manager.runOnce('key-1', fn1);
      await manager.runOnce('key-1', fn1);

      // Run second migration twice
      await manager.runOnce('key-2', fn2);
      await manager.runOnce('key-2', fn2);

      // Each should have been called exactly once
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it('should allow retrying one key without affecting others', async () => {
      let key1CallCount = 0;
      const fn1 = vi.fn(async () => {
        key1CallCount++;
        if (key1CallCount === 1) {
          throw new Error('First key failed');
        }
      });
      const fn2 = vi.fn(async () => {
        // noop
      });

      // First key fails
      await expect(manager.runOnce('key-1', fn1)).rejects.toThrow('First key failed');

      // Second key succeeds
      await manager.runOnce('key-2', fn2);
      expect(fn2).toHaveBeenCalledTimes(1);

      // First key still not marked
      expect(await manager.hasRun('key-1')).toBe(false);
      // Second key is marked
      expect(await manager.hasRun('key-2')).toBe(true);

      // Retry first key
      await manager.runOnce('key-1', fn1);
      expect(fn1).toHaveBeenCalledTimes(2);
      expect(await manager.hasRun('key-1')).toBe(true);

      // Second key should not run again
      await manager.runOnce('key-2', fn2);
      expect(fn2).toHaveBeenCalledTimes(1);
    });
  });

  describe('error: marker write fails → surfaced, not swallowed', () => {
    it('should surface errors from markRun after successful fn', async () => {
      const fn = vi.fn(async () => {
        // fn succeeds
      });

      // Mock the database to fail on put
      const db = manager['db'];
      const originalPut = db!.put;
      const markRunError = new Error('Database write failed');
      vi.spyOn(db!, 'put').mockRejectedValueOnce(markRunError);

      // runOnce should propagate the markRun error
      await expect(manager.runOnce('write-fail-key', fn)).rejects.toThrow('Database write failed');

      // fn should have been called
      expect(fn).toHaveBeenCalledTimes(1);

      // Migration should not be marked (because the write failed)
      expect(await manager.hasRun('write-fail-key')).toBe(false);

      vi.restoreAllMocks();
    });

    it('should surface hasRun errors', async () => {
      // Mock the database to fail on get
      const db = manager['db'];
      const checkError = new Error('Database read failed');
      vi.spyOn(db!, 'get').mockRejectedValueOnce(checkError);

      // hasRun should propagate the error
      await expect(manager.hasRun('read-fail-key')).rejects.toThrow('Database read failed');

      vi.restoreAllMocks();
    });

    it('should surface hasRun errors in runOnce', async () => {
      const fn = vi.fn(async () => {
        // noop
      });

      // Mock the database to fail on the first get (the hasRun check in runOnce)
      const db = manager['db'];
      const checkError = new Error('Database read failed');
      vi.spyOn(db!, 'get').mockRejectedValueOnce(checkError);

      // runOnce should propagate the hasRun error
      await expect(manager.runOnce('read-fail-key', fn)).rejects.toThrow('Database read failed');

      // fn should never have been called
      expect(fn).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  describe('initialization and closure', () => {
    it('should throw if runOnce is called before init', async () => {
      const uninitializedManager = new MigrationsManager('test-db');

      const fn = vi.fn(async () => {
        // noop
      });

      await expect(uninitializedManager.runOnce('key', fn)).rejects.toThrow(
        'MigrationsManager not initialized'
      );
    });

    it('should throw if hasRun is called before init', async () => {
      const uninitializedManager = new MigrationsManager('test-db');

      await expect(uninitializedManager.hasRun('key')).rejects.toThrow(
        'MigrationsManager not initialized'
      );
    });

    it('should throw if markRun is called before init', async () => {
      const uninitializedManager = new MigrationsManager('test-db');

      await expect(uninitializedManager.markRun('key')).rejects.toThrow(
        'MigrationsManager not initialized'
      );
    });

    it('should allow close to be called multiple times safely', () => {
      manager.close();
      manager.close(); // Should not throw
      expect(manager['db']).toBe(null);
    });
  });

  describe('hasRun and markRun directly', () => {
    it('hasRun should return false for unmigrated key', async () => {
      expect(await manager.hasRun('never-run')).toBe(false);
    });

    it('markRun should mark a key as run', async () => {
      expect(await manager.hasRun('manual-key')).toBe(false);

      await manager.markRun('manual-key');

      expect(await manager.hasRun('manual-key')).toBe(true);
    });

    it('markRun should store timestamp', async () => {
      const beforeTime = new Date();
      await manager.markRun('timestamped-key');
      const afterTime = new Date();

      // Get the raw record
      const db = manager['db'];
      const record = await db!.get('migrations', 'timestamped-key');

      expect(record).toBeDefined();
      expect(record.key).toBe('timestamped-key');
      expect(record.ranAt).toBeDefined();

      const ranAt = new Date(record.ranAt);
      expect(ranAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(ranAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });
});
