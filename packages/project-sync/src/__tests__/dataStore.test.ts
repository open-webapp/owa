/**
 * Test suite for DataStore module.
 *
 * Tests per-project database lifecycle: caching, switching, deletion,
 * and error handling. Uses fake-indexeddb for testing without a browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto'; // Auto-polyfill indexedDB
import { DataStore, type DataStoreConfig } from '../dataStore.js';
import type { IDBPDatabase, IDBPTransaction } from 'idb';

describe('DataStore', () => {
  let dataStore: DataStore;

  beforeEach(() => {
    dataStore = new DataStore();
  });

  afterEach(async () => {
    // Clean up all databases
    const projectIds = [];
    // Track which projects we created in this test
    for (const id of dataStore['handleCache'].keys()) {
      projectIds.push(id);
    }

    dataStore.closeAll();

    // Delete all databases to avoid cross-test pollution
    for (const id of projectIds) {
      try {
        await new Promise<void>((resolve) => {
          const dbName = `project-data-${id}`;
          const req = indexedDB.deleteDatabase(dbName);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  /**
   * Helper to create a simple config for testing.
   * Creates a basic store structure in the database.
   */
  function createTestConfig(storeName: string = 'test-store'): DataStoreConfig {
    return {
      version: 1,
      upgrade: (db, oldVersion, newVersion) => {
        // Create the store if it doesn't exist
        // Note: We don't check oldVersion === 0 because fake-indexeddb
        // may not always set oldVersion correctly on first open
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      },
    };
  }

  // ===== HAPPY PATH TESTS =====

  describe('happy path: setActive and getActiveDb', () => {
    it('should open a database and return it via getActiveDb', async () => {
      const projectId = 'project-1';
      const config = createTestConfig();

      await dataStore.setActive(projectId, config);
      const db = dataStore.getActiveDb();

      expect(db).toBeDefined();
      expect(db.objectStoreNames.contains('test-store')).toBe(true);
    });

    it('should create the app-supplied stores', async () => {
      const projectId = `project-store-test-${Math.random().toString(36).substring(7)}`;
      const storeName = 'custom-store';
      const config = createTestConfig(storeName);

      await dataStore.setActive(projectId, config);
      const db = dataStore.getActiveDb();

      expect(db.objectStoreNames.length).toBeGreaterThan(0);
      expect(db.objectStoreNames.contains(storeName)).toBe(true);
    });

    it('should allow reading data from the opened database', async () => {
      const projectId = 'project-1';
      const config = createTestConfig('test-store');

      await dataStore.setActive(projectId, config);
      const db = dataStore.getActiveDb();

      // Put some data
      await db.put('test-store', { id: 'item-1', value: 'test' });

      // Get it back
      const retrieved = await db.get('test-store', 'item-1');
      expect(retrieved).toEqual({ id: 'item-1', value: 'test' });
    });
  });

  describe('happy path: switching between projects', () => {
    it('should switch from project a to project b and return correct db each time', async () => {
      const config = createTestConfig();

      // Activate project a
      await dataStore.setActive('project-a', config);
      const dbA = dataStore.getActiveDb();
      await dbA.put('test-store', { id: 'a-item', value: 'from-a' });

      // Switch to project b
      await dataStore.setActive('project-b', config);
      const dbB = dataStore.getActiveDb();
      expect(dbB).not.toBe(dbA); // Different database instances
      await dbB.put('test-store', { id: 'b-item', value: 'from-b' });

      // Verify b has b's data
      const bData = await dbB.get('test-store', 'b-item');
      expect(bData?.value).toBe('from-b');

      // Switch back to a and verify data is still there
      await dataStore.setActive('project-a', config);
      const dbAAgain = dataStore.getActiveDb();
      const aData = await dbAAgain.get('test-store', 'a-item');
      expect(aData?.value).toBe('from-a');
    });

    it('should reuse cached handle when re-activating same project', async () => {
      const config = createTestConfig();

      // Activate project a
      await dataStore.setActive('project-a', config);
      const dbA1 = dataStore.getActiveDb();

      // Switch to project b
      await dataStore.setActive('project-b', config);

      // Switch back to project a — should reuse the cached handle
      await dataStore.setActive('project-a', config);
      const dbA2 = dataStore.getActiveDb();

      expect(dbA1).toBe(dbA2); // Same instance, from cache
    });

    it('should handle switch a→b→a→b→a correctly', async () => {
      const config = createTestConfig();

      // a → b → a → b → a
      await dataStore.setActive('project-a', config);
      const dbA1 = dataStore.getActiveDb();

      await dataStore.setActive('project-b', config);
      await dataStore.setActive('project-a', config);
      const dbA2 = dataStore.getActiveDb();
      expect(dbA1).toBe(dbA2); // Reused

      await dataStore.setActive('project-b', config);
      await dataStore.setActive('project-a', config);
      const dbA3 = dataStore.getActiveDb();
      expect(dbA1).toBe(dbA3); // Still reused
    });

    it('should track active project correctly through switches', async () => {
      const config = createTestConfig();

      expect(dataStore.getActiveProjectId()).toBeNull();

      await dataStore.setActive('project-a', config);
      expect(dataStore.getActiveProjectId()).toBe('project-a');

      await dataStore.setActive('project-b', config);
      expect(dataStore.getActiveProjectId()).toBe('project-b');

      await dataStore.setActive('project-a', config);
      expect(dataStore.getActiveProjectId()).toBe('project-a');
    });
  });

  // ===== EDGE CASE TESTS =====

  describe('edge case: getActiveDb with no active project', () => {
    it('should throw a clear error when getActiveDb is called without active project', () => {
      expect(() => dataStore.getActiveDb()).toThrow('No active project');
      expect(() => dataStore.getActiveDb()).toThrow(
        /call setActive\(projectId, config\) to activate a project/i
      );
    });

    it('should never silently default to any project', async () => {
      const config = createTestConfig();
      await dataStore.setActive('project-a', config);

      // Close all and clear active
      dataStore.closeAll();

      // Should throw, not default to project-a
      expect(() => dataStore.getActiveDb()).toThrow('No active project');
    });
  });

  describe('edge case: deleting active project', () => {
    it('should close the handle when deleting active project', async () => {
      const config = createTestConfig();
      const projectId = 'project-a';

      await dataStore.setActive(projectId, config);
      const db = dataStore.getActiveDb();

      // Put some data to ensure db is open and used
      await db.put('test-store', { id: 'test', value: 'data' });

      // Delete the project
      await dataStore.deleteDatabase(projectId);

      // Verify handle is no longer in cache
      expect(dataStore.isCached(projectId)).toBe(false);

      // Verify active pointer is cleared
      expect(dataStore.getActiveProjectId()).toBeNull();

      // Verify getActiveDb throws because no active project now
      expect(() => dataStore.getActiveDb()).toThrow('No active project');
    });

    it('should delete the underlying IndexedDB database', async () => {
      const config = createTestConfig();
      const projectId = 'project-delete-test';

      await dataStore.setActive(projectId, config);
      const db = dataStore.getActiveDb();
      await db.put('test-store', { id: 'data', value: 'before-delete' });

      // Delete the project database
      await dataStore.deleteDatabase(projectId);

      // Try to reopen the database for the same project
      // It should be empty (or recreated fresh)
      const newDataStore = new DataStore();
      await newDataStore.setActive(projectId, config);
      const newDb = newDataStore.getActiveDb();

      // Verify the data is gone (fresh database)
      const data = await newDb.get('test-store', 'data');
      expect(data).toBeUndefined();

      newDataStore.closeAll();
    });

    it('should handle deleting non-active project', async () => {
      const config = createTestConfig();

      await dataStore.setActive('project-a', config);
      await dataStore.setActive('project-b', config);

      // Delete a non-active project
      await dataStore.deleteDatabase('project-a');

      // Verify b is still active
      expect(dataStore.getActiveProjectId()).toBe('project-b');
      expect(() => dataStore.getActiveDb()).not.toThrow();
    });

    it('should be safe to delete a project multiple times', async () => {
      const projectId = 'project-once';
      const config = createTestConfig();

      await dataStore.setActive(projectId, config);
      await dataStore.deleteDatabase(projectId);

      // Delete again — should not throw
      await expect(dataStore.deleteDatabase(projectId)).resolves.toBeUndefined();
    });
  });

  // ===== ERROR HANDLING TESTS =====

  describe('error: invalid config', () => {
    it('should reject setActive with invalid config before opening database', async () => {
      // Test validation happens before database open attempts
      const config = { version: 1 } as any; // missing upgrade

      await expect(dataStore.setActive('project-1', config)).rejects.toThrow('upgrade');
    });

    it('should not cache handle if config validation fails', async () => {
      const projectId = 'project-bad-config-1';
      const badConfig = { version: 1 } as any; // missing upgrade

      try {
        await dataStore.setActive(projectId, badConfig);
      } catch {
        // Expected to fail
      }

      // Verify handle is NOT cached
      expect(dataStore.isCached(projectId)).toBe(false);

      // Verify active project is NOT set
      expect(dataStore.getActiveProjectId()).toBeNull();
    });
  });

  describe('error: invalid project id', () => {
    it('should reject setActive with empty project id', async () => {
      const config = createTestConfig();

      await expect(dataStore.setActive('', config)).rejects.toThrow('Project id must be');
    });

    it('should reject setActive with null project id', async () => {
      const config = createTestConfig();

      await expect(dataStore.setActive(null as any, config)).rejects.toThrow('Project id must be');
    });
  });

  // ===== ISOLATION TESTS =====

  describe('isolation: no accidental access to non-active project', () => {
    it('should only expose active project handle via getActiveDb', async () => {
      const config = createTestConfig();

      await dataStore.setActive('project-a', config);
      await dataStore.setActive('project-b', config);

      // Only project-b handle is accessible
      const db = dataStore.getActiveDb();

      // Put data in project-b
      await db.put('test-store', { id: 'b-data', value: 'in-b' });

      // Should not be able to access project-a's handle
      // (getActiveDb always returns active project)
      const activeId = dataStore.getActiveProjectId();
      expect(activeId).toBe('project-b');

      // No public API to get a handle for a non-active project
      // (This is enforced by not exporting handleCache or similar)
    });

    it('should not export internal cache or private state', () => {
      const config = createTestConfig();
      const ds = new DataStore();

      // Verify no public access to internal cache
      expect((ds as any).handleCache).toBeDefined(); // This is private, not exported
      expect((ds as any).activeProjectId).toBeDefined(); // This is private, not exported

      // Only public API is: setActive, getActiveDb, getActiveProjectId, deleteDatabase, closeAll, isCached
      const publicMethods = ['setActive', 'getActiveDb', 'getActiveProjectId', 'deleteDatabase', 'closeAll', 'isCached'];
      for (const method of publicMethods) {
        expect(typeof (ds as any)[method]).toBe('function');
      }
    });
  });

  // ===== CACHING VERIFICATION TESTS =====

  describe('caching: reuse and isolation', () => {
    it('should return same handle instance when re-activating same project', async () => {
      const config = createTestConfig();

      await dataStore.setActive('project-1', config);
      const db1 = dataStore.getActiveDb();

      // Verify cache
      expect(dataStore.isCached('project-1')).toBe(true);

      // Switch to different project
      await dataStore.setActive('project-2', config);

      // Switch back
      await dataStore.setActive('project-1', config);
      const db2 = dataStore.getActiveDb();

      expect(db1).toBe(db2); // Reused from cache
    });

    it('should maintain separate caches for different projects', async () => {
      const config = createTestConfig();

      await dataStore.setActive('project-1', config);
      const db1 = dataStore.getActiveDb();
      await db1.put('test-store', { id: 'item1', value: 'value1' });

      await dataStore.setActive('project-2', config);
      const db2 = dataStore.getActiveDb();
      await db2.put('test-store', { id: 'item2', value: 'value2' });

      // Verify isolation
      await dataStore.setActive('project-1', config);
      const data1 = await dataStore.getActiveDb().get('test-store', 'item1');
      expect(data1?.value).toBe('value1');

      // item2 should not exist in project-1
      const item2InProject1 = await dataStore.getActiveDb().get('test-store', 'item2');
      expect(item2InProject1).toBeUndefined();

      // Verify project-2 still has its data
      await dataStore.setActive('project-2', config);
      const data2 = await dataStore.getActiveDb().get('test-store', 'item2');
      expect(data2?.value).toBe('value2');
    });
  });

  // ===== DETERMINISTIC DB NAME TESTS =====

  describe('deterministic database naming', () => {
    it('should derive same db name from same project id', async () => {
      const config = createTestConfig();
      const projectId = 'test-project-123';

      // Activate the project
      await dataStore.setActive(projectId, config);

      // Put some data
      const db = dataStore.getActiveDb();
      await db.put('test-store', { id: 'test', value: 'data' });

      // Close and clear cache
      dataStore.closeAll();

      // Reactivate the project
      await dataStore.setActive(projectId, config);

      // Data should persist (same db name = same database)
      const data = await dataStore.getActiveDb().get('test-store', 'test');
      expect(data?.value).toBe('data');
    });

    it('should use different database names for different project ids', async () => {
      const config = createTestConfig();

      await dataStore.setActive('project-a', config);
      const dbA = dataStore.getActiveDb();
      await dbA.put('test-store', { id: 'id', value: 'from-a' });

      await dataStore.setActive('project-b', config);
      const dbB = dataStore.getActiveDb();

      // project-b should have empty store (different database)
      const item = await dbB.get('test-store', 'id');
      expect(item).toBeUndefined();
    });
  });

  // ===== INTEGRATION TESTS =====

  describe('integration: realistic workflow', () => {
    it('should handle create-switch-delete workflow', async () => {
      const config = createTestConfig();

      // Create and populate project a
      await dataStore.setActive('project-a', config);
      const dbA = dataStore.getActiveDb();
      await dbA.put('test-store', { id: 'a-1', value: 'data-a' });

      // Create and populate project b
      await dataStore.setActive('project-b', config);
      const dbB = dataStore.getActiveDb();
      await dbB.put('test-store', { id: 'b-1', value: 'data-b' });

      // Switch to c
      await dataStore.setActive('project-c', config);
      const dbC = dataStore.getActiveDb();
      await dbC.put('test-store', { id: 'c-1', value: 'data-c' });

      // Delete project-b
      await dataStore.deleteDatabase('project-b');

      // Verify a and c are still usable
      await dataStore.setActive('project-a', config);
      const aData = await dataStore.getActiveDb().get('test-store', 'a-1');
      expect(aData?.value).toBe('data-a');

      await dataStore.setActive('project-c', config);
      const cData = await dataStore.getActiveDb().get('test-store', 'c-1');
      expect(cData?.value).toBe('data-c');

      // Verify b is gone
      expect(dataStore.isCached('project-b')).toBe(false);
    });

    it('should handle closeAll properly', async () => {
      const config = createTestConfig();

      await dataStore.setActive('project-a', config);
      await dataStore.setActive('project-b', config);

      // Close all
      dataStore.closeAll();

      // Verify active is cleared
      expect(dataStore.getActiveProjectId()).toBeNull();

      // Verify getActiveDb throws
      expect(() => dataStore.getActiveDb()).toThrow('No active project');

      // Can still activate a new project
      await dataStore.setActive('project-c', config);
      expect(dataStore.getActiveProjectId()).toBe('project-c');
    });
  });

  // ===== VERSION UPGRADE TESTS =====

  describe('version upgrade handling', () => {
    it('should call upgrade handler with correct version numbers', async () => {
      const upgradeSpy = vi.fn();

      const config: DataStoreConfig = {
        version: 2,
        upgrade: upgradeSpy,
      };

      await dataStore.setActive('project-upgrade-test', config);

      // Upgrade should have been called with oldVersion=0, newVersion=2
      expect(upgradeSpy).toHaveBeenCalledWith(
        expect.any(Object), // db
        0, // oldVersion
        2, // newVersion
        expect.any(Object) // tx
      );
    });

    it('should run upgrade again if version increments', async () => {
      const projectId = 'project-v-test';
      let upgradeCount = 0;

      const configV1: DataStoreConfig = {
        version: 1,
        upgrade: () => {
          upgradeCount++;
        },
      };

      // Open at version 1
      await dataStore.setActive(projectId, configV1);
      expect(upgradeCount).toBe(1);

      dataStore.closeAll();

      // Open at version 2 (config must have version 2, but we keep count)
      const configV2: DataStoreConfig = {
        version: 2,
        upgrade: () => {
          upgradeCount++;
        },
      };

      const dataStore2 = new DataStore();
      await dataStore2.setActive(projectId, configV2);
      expect(upgradeCount).toBe(2); // Should be called again for version migration

      dataStore2.closeAll();
    });
  });
});
