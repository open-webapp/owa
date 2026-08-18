/**
 * Comprehensive tests for the document sync engine.
 *
 * Mirrors notesdiary's shipped driveSyncFilterRuleVersioning.test.tsx cases
 * to ensure parity of the try-write-first algorithm.
 *
 * Test all paths:
 * - Pure push (cached fileId, write succeeds first try)
 * - Conflict recovery (remote-changed, never-restored)
 * - Create new file path
 * - Self-heal (find by name)
 * - Retry exhaustion
 * - Non-retryable errors
 * - Null remote content
 * - Document set changes
 * - Uint8Array payloads
 * - Merge conflicts
 * - Per-document error isolation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemoteChangedError } from '@open-webapp/drive-sync';
import { syncDocuments, syncDocument, type SyncDocumentsOptions, type SyncDocumentResult } from '../documents.js';
import type { Project, SyncDocument } from '../types.js';

/**
 * Mock implementations for testing.
 */

interface MockFilesHandle {
  list: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

interface MockSyncState {
  getFileId: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function createMockFiles(): MockFilesHandle {
  return {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    status: vi.fn(),
    remove: vi.fn(),
  };
}

function createMockSyncState(): MockSyncState {
  return {
    getFileId: vi.fn(),
    update: vi.fn(),
  };
}

function createTestProject(): Project {
  return {
    id: 'p_test_001',
    name: 'Test Project',
    createdAt: new Date().toISOString(),
  };
}

function createTestDocument(overrides?: Partial<SyncDocument>): SyncDocument {
  return {
    key: 'doc-1',
    name: 'test-doc.json',
    mimeType: 'application/json',
    readLocal: vi.fn(async () => 'local content'),
    writeLocal: vi.fn(async () => {}),
    merge: vi.fn(async (local, remote) => ({
      merged: remote || local || '',
      conflicts: [],
    })),
    ...overrides,
  };
}

describe('syncDocuments - document sync engine', () => {
  let files: MockFilesHandle;
  let syncState: MockSyncState;
  let project: Project;
  let logger: any;

  beforeEach(() => {
    files = createMockFiles();
    syncState = createMockSyncState();
    project = createTestProject();
    logger = {
      log: vi.fn(),
    };
  });

  describe('pure push - zero reads, one write', () => {
    it('cached fileId, write succeeds first try → no files.read, no files.list, no merge, no writeLocal', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local content');
      files.write.mockResolvedValue({ id: 'file-123', name: 'test-doc.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(true);
      expect(result[0].driveFileId).toBe('file-123');
      expect(result[0].writeAttempts).toBe(1);
      expect(result[0].readAttempts).toBe(0);

      // Assert pure push: zero reads and lists
      expect(files.read).not.toHaveBeenCalled();
      expect(files.list).not.toHaveBeenCalled();
      expect(doc.merge).not.toHaveBeenCalled();
      expect(doc.writeLocal).not.toHaveBeenCalled();

      // Assert write called exactly once with fileId, no folderId/name
      expect(files.write).toHaveBeenCalledTimes(1);
      const writeCall = files.write.mock.calls[0][0];
      expect(writeCall.fileId).toBe('file-123');
      expect(writeCall.content).toBe('local content');
      expect(writeCall.mimeType).toBe('application/json');
      expect(writeCall.folderId).toBeUndefined();
      expect(writeCall.name).toBeUndefined();

      // Assert state updated with fileId
      expect(syncState.update).toHaveBeenCalledTimes(1);
      const updateCall = syncState.update.mock.calls[0];
      expect(updateCall[0]).toBe('doc-1');
      expect(updateCall[1]).toBe('file-123');
    });
  });

  describe('conflict recovery', () => {
    it('conflict "remote-changed" → files.read once, files.write twice, merge, writeLocal', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local content');

      // First write throws RemoteChangedError
      files.write.mockRejectedValueOnce(
        new RemoteChangedError({
          fileId: 'file-123',
          baseVersion: 'v1',
          remoteVersion: 'v2',
          reason: 'remote-changed',
        })
      );

      // Read remote
      files.read.mockResolvedValueOnce('remote content');

      // Second write succeeds
      files.write.mockResolvedValueOnce({ id: 'file-123', name: 'test-doc.json' });

      // Merge returns merged content
      doc.merge.mockResolvedValueOnce({ merged: 'merged content', conflicts: [] });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);
      expect(result[0].writeAttempts).toBe(2);
      expect(result[0].readAttempts).toBe(1);

      // Assert sequence: write, read, merge, writeLocal, write
      expect(files.write).toHaveBeenCalledTimes(2);
      expect(files.read).toHaveBeenCalledTimes(1);
      expect(files.read).toHaveBeenCalledWith('file-123');
      expect(doc.merge).toHaveBeenCalledTimes(1);
      expect(doc.merge).toHaveBeenCalledWith('local content', 'remote content');
      expect(doc.writeLocal).toHaveBeenCalledTimes(1);
      expect(doc.writeLocal).toHaveBeenCalledWith('merged content');
    });

    it('conflict "never-restored" (first sync of pre-existing file) → same handling, distinguishable log', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local content');

      // First write throws RemoteChangedError with 'never-restored' reason
      files.write.mockRejectedValueOnce(
        new RemoteChangedError({
          fileId: 'file-123',
          baseVersion: null,
          remoteVersion: 'v1',
          reason: 'never-restored',
        })
      );

      files.read.mockResolvedValueOnce('remote content');
      files.write.mockResolvedValueOnce({ id: 'file-123', name: 'test-doc.json' });
      doc.merge.mockResolvedValueOnce({ merged: 'merged content', conflicts: [] });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);

      // Assert distinguishable log: should log 'first sync' for never-restored
      const debugLogs = logger.log.mock.calls.filter((c: any) => c[0] === 'debug');
      const conflictLog = debugLogs.find((c: any) =>
        c[1].includes('first sync against pre-existing file')
      );
      expect(conflictLog).toBeDefined();
    });
  });

  describe('create new file path', () => {
    it('no cached id, list returns [] → single write with folderId+name, no fileId, no read', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue(null); // No cached ID
      doc.readLocal = vi.fn(async () => 'local content');

      // List finds nothing
      files.list.mockResolvedValueOnce([]);

      // Write succeeds (with folderId+name, no fileId)
      files.write.mockResolvedValueOnce({ id: 'file-new', name: 'test-doc.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);
      expect(result[0].driveFileId).toBe('file-new');
      expect(result[0].writeAttempts).toBe(1);

      // Assert list was called
      expect(files.list).toHaveBeenCalledTimes(1);
      expect(files.list).toHaveBeenCalledWith({
        folderId: 'folder-123',
        nameEquals: 'test-doc.json',
      });

      // Assert write called with folderId+name, no fileId
      expect(files.write).toHaveBeenCalledTimes(1);
      const writeCall = files.write.mock.calls[0][0];
      expect(writeCall.folderId).toBe('folder-123');
      expect(writeCall.name).toBe('test-doc.json');
      expect(writeCall.fileId).toBeUndefined();

      // Assert no read
      expect(files.read).not.toHaveBeenCalled();
    });
  });

  describe('self-heal', () => {
    it('no cached id, list finds file by name → id flows into loop, hits never-restored, resolves', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue(null); // No cached ID
      doc.readLocal = vi.fn(async () => 'local content');

      // List finds the file
      files.list.mockResolvedValueOnce([
        { id: 'file-found', name: 'test-doc.json' }
      ]);

      // Write throws RemoteChangedError (never-restored)
      files.write.mockRejectedValueOnce(
        new RemoteChangedError({
          fileId: 'file-found',
          baseVersion: null,
          remoteVersion: 'v1',
          reason: 'never-restored',
        })
      );

      // Read and merge
      files.read.mockResolvedValueOnce('remote content');
      files.write.mockResolvedValueOnce({ id: 'file-found', name: 'test-doc.json' });
      doc.merge.mockResolvedValueOnce({ merged: 'merged content', conflicts: [] });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);
      expect(result[0].driveFileId).toBe('file-found');

      // Assert state updated (self-heal persists the id)
      expect(syncState.update).toHaveBeenCalledTimes(1);
      const updateCall = syncState.update.mock.calls[0];
      expect(updateCall[0]).toBe('doc-1');
      expect(updateCall[1]).toBe('file-found');
    });
  });

  describe('retry exhaustion', () => {
    it('RemoteChangedError every time → exactly 3 writes, exactly 2 reads, throws', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local content');

      // All three writes throw RemoteChangedError
      files.write.mockRejectedValue(
        new RemoteChangedError({
          fileId: 'file-123',
          baseVersion: 'v1',
          remoteVersion: 'v2',
          reason: 'remote-changed',
        })
      );

      // Reads return remote content
      files.read.mockResolvedValue('remote content');
      doc.merge.mockResolvedValue({ merged: 'merged content', conflicts: [] });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(false);
      expect(result[0].error?.message).toBe('Sync conflict could not be resolved');
      expect(result[0].writeAttempts).toBe(3);
      expect(result[0].readAttempts).toBe(2);

      // Assert exactly 3 writes, 2 reads
      expect(files.write).toHaveBeenCalledTimes(3);
      expect(files.read).toHaveBeenCalledTimes(2);
    });
  });

  describe('non-retryable errors', () => {
    it('non-RemoteChangedError (network) → exactly 1 write, 0 reads, no retry', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local content');

      // Write throws a network error (not RemoteChangedError)
      const networkError = new Error('Network error');
      files.write.mockRejectedValueOnce(networkError);

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(false);
      expect(result[0].error?.message).toBe('Network error');
      expect(result[0].writeAttempts).toBe(1);
      expect(result[0].readAttempts).toBe(0);

      // Assert exactly 1 write, 0 reads
      expect(files.write).toHaveBeenCalledTimes(1);
      expect(files.read).not.toHaveBeenCalled();
    });
  });

  describe('null remote content', () => {
    it('remote read returns null/empty → merge receives null remote, write proceeds, no crash', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local content');

      // First write throws RemoteChangedError
      files.write.mockRejectedValueOnce(
        new RemoteChangedError({
          fileId: 'file-123',
          baseVersion: 'v1',
          remoteVersion: 'v2',
          reason: 'remote-changed',
        })
      );

      // Read returns null
      files.read.mockResolvedValueOnce(null);

      // Second write succeeds
      files.write.mockResolvedValueOnce({ id: 'file-123', name: 'test-doc.json' });

      doc.merge.mockResolvedValueOnce({ merged: 'local content', conflicts: [] });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);

      // Assert merge received null as remote
      expect(doc.merge).toHaveBeenCalledWith('local content', null);
    });
  });

  describe('document set changes', () => {
    it('new doc synced, removed doc left alone in Drive', async () => {
      const doc1 = createTestDocument({ key: 'doc-1', name: 'doc1.json' });
      const doc2 = createTestDocument({ key: 'doc-2', name: 'doc2.json' });

      syncState.getFileId.mockImplementation((key) => {
        if (key === 'doc-1') return 'file-1';
        if (key === 'doc-2') return 'file-2';
        return null;
      });

      doc1.readLocal = vi.fn(async () => 'content1');
      doc2.readLocal = vi.fn(async () => 'content2');

      files.write.mockResolvedValue({ id: 'file-new', name: 'test-doc.json' });

      // Sync with doc1 only (doc2 is removed from the set)
      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc1],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('doc-1');

      // Assert doc2 was not synced (it's removed from the set)
      expect(doc2.readLocal).not.toHaveBeenCalled();
    });
  });

  describe('Uint8Array payloads', () => {
    it('Uint8Array payload round-trips byte-identical (encrypted case)', async () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => payload);
      files.write.mockResolvedValue({ id: 'file-123', name: 'test-doc.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);

      // Assert write received a Blob (converted from Uint8Array)
      const writeCall = files.write.mock.calls[0][0];
      expect(writeCall.content).toBeInstanceOf(Blob);

      // Verify the Blob contains the correct bytes
      const blobBytes = new Uint8Array(await (writeCall.content as Blob).arrayBuffer());
      expect(blobBytes).toEqual(payload);
    });
  });

  describe('merge conflicts', () => {
    it('merge returns conflicts → surfaced in result, write still proceeds with merged', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local content');

      // First write throws RemoteChangedError
      files.write.mockRejectedValueOnce(
        new RemoteChangedError({
          fileId: 'file-123',
          baseVersion: 'v1',
          remoteVersion: 'v2',
          reason: 'remote-changed',
        })
      );

      files.read.mockResolvedValueOnce('remote content');

      // Merge returns conflicts
      const conflicts = [{ type: 'deletion', key: 'entry-1' }];
      doc.merge.mockResolvedValueOnce({ merged: 'merged content', conflicts });

      files.write.mockResolvedValueOnce({ id: 'file-123', name: 'test-doc.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);
      expect(result[0].conflicts).toEqual(conflicts);

      // Assert write proceeded with merged
      const secondWrite = files.write.mock.calls[1][0];
      expect(secondWrite.content).toBe('merged content');
    });
  });

  describe('per-document error isolation', () => {
    it('one document fails → other documents still sync; failure reported per document', async () => {
      const doc1 = createTestDocument({ key: 'doc-1', name: 'doc1.json' });
      const doc2 = createTestDocument({ key: 'doc-2', name: 'doc2.json' });

      syncState.getFileId.mockImplementation((key) => {
        if (key === 'doc-1') return 'file-1';
        if (key === 'doc-2') return 'file-2';
        return null;
      });

      doc1.readLocal = vi.fn(async () => 'content1');
      doc2.readLocal = vi.fn(async () => 'content2');

      // doc1 write fails
      files.write.mockRejectedValueOnce(new Error('doc1 error'));
      // doc2 write succeeds
      files.write.mockResolvedValueOnce({ id: 'file-2', name: 'doc2.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc1, doc2],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result).toHaveLength(2);
      expect(result[0].success).toBe(false);
      expect(result[0].error?.message).toBe('doc1 error');
      expect(result[1].success).toBe(true);

      // Assert both were attempted
      expect(doc1.readLocal).toHaveBeenCalled();
      expect(doc2.readLocal).toHaveBeenCalled();
    });
  });

  describe('edge cases and error handling', () => {
    it('empty document set → returns empty results array', async () => {
      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result).toEqual([]);
    });

    it('document readLocal returns null → creates with empty content', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue(null);
      doc.readLocal = vi.fn(async () => null);

      files.list.mockResolvedValueOnce([]);
      files.write.mockResolvedValueOnce({ id: 'file-new', name: 'test-doc.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);

      // Assert write was called with empty content (null → '')
      const writeCall = files.write.mock.calls[0][0];
      expect(writeCall.content).toBe('');
    });

    it('list throws error → falls through to creation', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue(null);
      doc.readLocal = vi.fn(async () => 'local content');

      files.list.mockRejectedValueOnce(new Error('list failed'));
      files.write.mockResolvedValueOnce({ id: 'file-new', name: 'test-doc.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);
      expect(files.write).toHaveBeenCalled();
    });
  });

  describe('state updates', () => {
    it('syncState.update called with correct arguments on success', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'content');
      files.write.mockResolvedValue({ id: 'file-123', name: 'test-doc.json' });

      await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(syncState.update).toHaveBeenCalledTimes(1);
      const updateCall = syncState.update.mock.calls[0];
      expect(updateCall[0]).toBe('doc-1');
      expect(updateCall[1]).toBe('file-123');
    });

    it('syncState.update called with conflicts when merge produces them', async () => {
      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => 'local');

      files.write.mockRejectedValueOnce(
        new RemoteChangedError({
          fileId: 'file-123',
          baseVersion: 'v1',
          remoteVersion: 'v2',
          reason: 'remote-changed',
        })
      );

      files.read.mockResolvedValueOnce('remote');
      const conflicts = [{ type: 'conflict', key: 'x' }];
      doc.merge.mockResolvedValueOnce({ merged: 'merged', conflicts });
      files.write.mockResolvedValueOnce({ id: 'file-123', name: 'test-doc.json' });

      await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(syncState.update).toHaveBeenCalledTimes(1);
      const updateCall = syncState.update.mock.calls[0];
      expect(updateCall[0]).toBe('doc-1');
      expect(updateCall[1]).toBe('file-123');
      expect(updateCall[2]).toEqual(conflicts);
    });

    it('Blob remote content is converted to Uint8Array for merge', async () => {
      const localPayload = new Uint8Array([0x01, 0x02]);
      const remoteBytes = new Uint8Array([0x03, 0x04, 0x05]);
      const remoteBlob = new Blob([remoteBytes], { type: 'application/octet-stream' });

      const doc = createTestDocument();
      syncState.getFileId.mockReturnValue('file-123');
      doc.readLocal = vi.fn(async () => localPayload);

      // First write throws RemoteChangedError
      files.write.mockRejectedValueOnce(
        new RemoteChangedError({
          fileId: 'file-123',
          baseVersion: 'v1',
          remoteVersion: 'v2',
          reason: 'remote-changed',
        })
      );

      // Remote is a Blob (binary file)
      files.read.mockResolvedValueOnce(remoteBlob);

      // Merge should receive the converted Uint8Array
      doc.merge.mockResolvedValueOnce({ merged: remoteBytes, conflicts: [] });
      files.write.mockResolvedValueOnce({ id: 'file-123', name: 'test-doc.json' });

      const result = await syncDocuments({
        project,
        projectFolderId: 'folder-123',
        documents: () => [doc],
        files: files as any,
        syncState: syncState as any,
        logger,
      });

      expect(result[0].success).toBe(true);

      // Verify merge was called with the Blob converted to Uint8Array
      const mergeCall = doc.merge.mock.calls[0];
      expect(mergeCall[0]).toEqual(localPayload); // local
      expect(mergeCall[1]).toBeInstanceOf(Uint8Array); // remote (converted from Blob)
      expect(mergeCall[1]).toEqual(remoteBytes); // correct bytes
    });
  });
});
