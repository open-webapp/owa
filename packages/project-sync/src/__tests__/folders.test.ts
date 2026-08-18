import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  resolveProjectFolder,
  invalidateFolderVerificationMemo,
  invalidateAllFolderVerificationMemos,
  type ResolveFolderOptions,
  type FolderOperations,
  type ProjectWithFolderCache,
} from '../folders.js';
import type { Project } from '../types.js';

/**
 * Test suite for folder resolution with session-level verification caching.
 *
 * Implements decision 7 (names are truth, cached IDs are disposable) and
 * decision 24 (folder verification once per session, not per sync).
 *
 * Test cases match T15's specification exactly.
 */

// Mock Logger type
interface MockLogger {
  log: (level: string, message: string, context?: unknown) => void;
}

/**
 * Create a mock folder operations handler for testing with shared state.
 */
function createMockFolderOpsWithState() {
  const listCalls: any[] = [];
  const getCalls: any[] = [];
  const createFolderCalls: any[] = [];
  const updateCalls: any[] = [];

  // Simulate a Drive file structure in memory
  const files = new Map<string, any>();
  let nextId = 0;

  const ops: FolderOperations = {
    async list(opts: any) {
      listCalls.push(opts);
      // Return matching folders by name
      const results: any[] = [];
      for (const [, file] of files) {
        if (
          (!opts.folderId || file.parentId === opts.folderId) &&
          (!opts.nameEquals || file.name === opts.nameEquals) &&
          (!opts.mimeType || file.mimeType === opts.mimeType) &&
          !file.trashed
        ) {
          results.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
          });
        }
      }
      // Sort by createdTime ascending (oldest first)
      results.sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || ''));
      return results;
    },

    async get(opts: any) {
      getCalls.push(opts);
      const file = files.get(opts.fileId);
      if (!file) return null;
      if (file.trashed) return null;
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        trashed: file.trashed,
        createdTime: file.createdTime,
      };
    },

    async createFolder(opts: any) {
      createFolderCalls.push(opts);
      const id = `folder-${nextId++}`;
      const now = new Date().toISOString();
      files.set(id, {
        id,
        name: opts.name,
        mimeType: 'application/vnd.google-apps.folder',
        parentId: opts.parentId,
        trashed: false,
        createdTime: now,
        modifiedTime: now,
      });
      return id;
    },

    async update(opts: any) {
      updateCalls.push(opts);
      const file = files.get(opts.fileId);
      if (!file) throw new Error(`File not found: ${opts.fileId}`);
      if (opts.name !== undefined) {
        file.name = opts.name;
      }
      if (opts.addParents) {
        file.parentId = opts.addParents;
      }
    },
  };

  return { ops, listCalls, getCalls, createFolderCalls, updateCalls, files };
}

/**
 * Create a mock logger for testing.
 */
function createMockLogger(): { logger: MockLogger; logs: any[] } {
  const logs: any[] = [];
  const logger: MockLogger = {
    log(level: string, message: string, context?: unknown) {
      logs.push({ level, message, context });
    },
  };
  return { logger, logs };
}

/**
 * Create a base project for testing.
 */
function createTestProject(overrides?: Partial<ProjectWithFolderCache>): ProjectWithFolderCache {
  return {
    id: 'proj-1',
    name: 'My Project',
    createdAt: new Date().toISOString(),
    driveFolderId: undefined,
    ...overrides,
  };
}

describe('folders: folder resolution with session-level caching', () => {
  beforeEach(() => {
    // Clear memos before each test
    invalidateAllFolderVerificationMemos();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Happy path tests
  // =========================================================================

  it('happy: first run → creates OpenWebApp/<App>/<Project>, caches id', async () => {
    const { ops, createFolderCalls, listCalls } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();
    const project = createTestProject();

    const folderId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    expect(folderId).toBeTruthy();
    expect(project.driveFolderId).toBe(folderId);
    expect(createFolderCalls.length).toBe(3); // OpenWebApp, app, project
    expect(listCalls.length).toBeGreaterThan(0);
  });

  it('happy: second run in the same session → cache hit, no list and no verify call issued', async () => {
    const { ops, createFolderCalls, listCalls, getCalls } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();
    const project = createTestProject();

    // First run
    const firstId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    const firstListCount = listCalls.length;
    listCalls.length = 0;
    getCalls.length = 0;
    createFolderCalls.length = 0;

    // Second run in same session
    const secondId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    expect(secondId).toBe(firstId);
    // No new list or verify calls in second run
    expect(listCalls.length).toBe(0);
    expect(getCalls.length).toBe(0);
    expect(createFolderCalls.length).toBe(0);
  });

  it('happy: new session → exactly one verification call, then cached', async () => {
    const { ops, getCalls, listCalls, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    // Manually create a folder structure to verify
    files.set('folder-root', {
      id: 'folder-root',
      name: 'My Project',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      createdTime: '2023-01-01T00:00:00Z',
    });

    const project = createTestProject({
      driveFolderId: 'folder-root',
    });

    // First resolution
    const folderId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    // Should have done one verification call
    expect(getCalls.length).toBe(1);
    expect(folderId).toBe('folder-root');

    // Reset for second call in same session
    getCalls.length = 0;
    listCalls.length = 0;

    // Another call in the same session should use cache
    const folderId2 = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    expect(folderId2).toBe(folderId);
    expect(getCalls.length).toBe(0); // No verify call
  });

  // =========================================================================
  // Edge case tests
  // =========================================================================

  it('edge: explicit user-triggered sync invalidates the memo → exactly one re-verification', async () => {
    const { ops, getCalls, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    // Create a folder to verify
    files.set('folder-cached', {
      id: 'folder-cached',
      name: 'My Project',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      createdTime: '2023-01-01T00:00:00Z',
    });

    const project = createTestProject({
      driveFolderId: 'folder-cached',
    });

    // First resolution
    const firstId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    getCalls.length = 0;

    // Invalidate memo (simulating explicit "Sync now")
    invalidateFolderVerificationMemo('app-1', 'proj-1');

    // Second resolution should re-verify
    const secondId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    expect(getCalls.length).toBe(1); // One verify call
    expect(secondId).toBe(firstId);
  });

  it('edge: reconnect invalidates the memo', async () => {
    const { ops, getCalls, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    files.set('folder-reconnect', {
      id: 'folder-reconnect',
      name: 'My Project',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      createdTime: '2023-01-01T00:00:00Z',
    });

    const project = createTestProject({
      driveFolderId: 'folder-reconnect',
    });

    // First resolution
    await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    getCalls.length = 0;

    // Simulate reconnect
    invalidateAllFolderVerificationMemos();

    // Second resolution should re-verify
    await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    expect(getCalls.length).toBe(1); // One verify call after invalidation
  });

  it('edge: 10 background interval syncs in one session → exactly one verification total', async () => {
    const { ops, getCalls, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    files.set('folder-interval', {
      id: 'folder-interval',
      name: 'My Project',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      createdTime: '2023-01-01T00:00:00Z',
    });

    const project = createTestProject({
      driveFolderId: 'folder-interval',
    });

    // Clear memos and do first resolve
    invalidateAllFolderVerificationMemos();
    await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    const verifyCountAfterFirst = getCalls.length;
    getCalls.length = 0;

    // 9 more syncs in the same session
    for (let i = 0; i < 9; i++) {
      await resolveProjectFolder({
        appId: 'app-1',
        projectId: 'proj-1',
        clientId: 'client-1',
        appName: 'Notes Diary',
        project,
        folderOps: ops,
        logger,
      });
    }

    // Should still have only 1 verify call total (from the first resolution)
    expect(verifyCountAfterFirst).toBe(1);
    expect(getCalls.length).toBe(0); // No new calls in the remaining 9 syncs
  });

  it('edge: folder renamed in Drive → cache preserved and renamed to match (app-side rename semantics)', async () => {
    const { ops, updateCalls, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    // Create a folder with an old name
    const folderId = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'Old Name', // Different from project name
    });

    const project = createTestProject({
      name: 'My Project',
      driveFolderId: folderId,
    });

    invalidateAllFolderVerificationMemos();

    const resolvedId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    // Should preserve the cached folder ID and rename it
    expect(resolvedId).toBe(folderId);
    // Should have attempted to rename (update call)
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('edge: folder trashed → treated as absent, recreated', async () => {
    const { ops, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    // Create and trash a folder
    const trashedFolderId = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'My Project',
    });

    // Trash it manually
    const file = files.get(trashedFolderId);
    if (file) file.trashed = true;

    const project = createTestProject({
      driveFolderId: trashedFolderId,
    });

    invalidateAllFolderVerificationMemos();

    const resolvedId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    // Should create a new folder
    expect(resolvedId).not.toBe(trashedFolderId);
  });

  it('edge: two same-named folders → oldest returned on every call', async () => {
    const { ops, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    // Create the OpenWebApp parent
    const openWebApp = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'OpenWebApp',
    });

    // Create the app folder
    const appFolder = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'Notes Diary',
      parentId: openWebApp,
    });

    // Create two folders with the same name but different createdTime under the app folder
    const folder1 = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'My Project',
      parentId: appFolder,
    });

    // Manually set older createdTime
    const file1 = files.get(folder1);
    if (file1) file1.createdTime = '2023-01-01T00:00:00Z';

    // Create another folder with same name at same level
    const folder2 = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'My Project',
      parentId: appFolder,
    });

    // Manually set newer createdTime
    const file2 = files.get(folder2);
    if (file2) file2.createdTime = '2023-12-31T23:59:59Z';

    const project = createTestProject();
    invalidateAllFolderVerificationMemos();

    const resolvedId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    // Should resolve to the older folder
    expect(resolvedId).toBe(folder1);
  });

  it('edge: app-side project rename → Drive folder renamed, cache preserved', async () => {
    const { ops, updateCalls } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    // Create the folder hierarchy
    const openWebApp = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'OpenWebApp',
    });

    const appFolder = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'Notes Diary',
      parentId: openWebApp,
    });

    // Create initial folder with old name
    const folderId = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'Old Project Name',
      parentId: appFolder,
    });

    const project = createTestProject({
      name: 'New Project Name', // App renamed the project
      driveFolderId: folderId,
    });

    invalidateAllFolderVerificationMemos();

    const resolvedId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    // Should preserve the same folder ID (after rename)
    expect(resolvedId).toBe(folderId);
    // Should have attempted to rename (update call)
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Error tests
  // =========================================================================

  it('error: sibling already holds the target name on rename → rejected, no clobber', async () => {
    const { ops, files } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();

    // Create a parent folder and two children
    const parentId = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'OpenWebApp',
    });

    const folder1 = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'Project A',
      parentId,
    });

    const folder2 = await ops.createFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      name: 'Project B',
      parentId,
    });

    const project = createTestProject({
      id: 'proj-a',
      name: 'Project A', // Trying to use folder1
      driveFolderId: folder1,
    });

    // Wrap ops to reject rename if name already exists (sibling has it)
    const wrappedOps: FolderOperations = {
      list: ops.list.bind(ops),
      get: ops.get.bind(ops),
      createFolder: ops.createFolder.bind(ops),
      async update(opts) {
        // Simulate: cannot rename because sibling already has target name
        if (opts.name === 'Project B') {
          throw new Error('File with that name already exists at this location');
        }
        return ops.update(opts);
      },
    };

    invalidateAllFolderVerificationMemos();

    const resolvedId = await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: wrappedOps,
      logger,
    });

    // Should still resolve to the same folder (rename failed but folder is OK)
    expect(resolvedId).toBe(folder1);
  });

  // =========================================================================
  // Contract verification
  // =========================================================================

  it('contract: nothing resolves via appProperties', async () => {
    const { ops, listCalls, getCalls, createFolderCalls } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();
    const project = createTestProject();

    await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    // Verify no appProperties in calls
    const allCalls = [...listCalls, ...getCalls, ...createFolderCalls];
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toContain('appProperties');
    }
  });

  it('contract: resolution uses only file names, not IDs (except as source of truth)', async () => {
    const { ops, listCalls } = createMockFolderOpsWithState();
    const { logger } = createMockLogger();
    const project = createTestProject();

    await resolveProjectFolder({
      appId: 'app-1',
      projectId: 'proj-1',
      clientId: 'client-1',
      appName: 'Notes Diary',
      project,
      folderOps: ops,
      logger,
    });

    // The resolution flow should:
    // 1. Verify cached ID (if present) → lookup by ID
    // 2. Name lookup → by name
    // 3. Create → new ID
    // No ambiguous lookups by ID without first verifying name

    for (const call of listCalls) {
      // Each list call should have either folderId (parent) or be a root lookup
      // They should all have nameEquals or mimeType, not arbitrary ID lookups
      expect(call.nameEquals || call.mimeType).toBeDefined();
    }
  });
});
