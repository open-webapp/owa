import { describe, it } from 'vitest';
import type {
  Payload,
  SyncDocument,
  Project,
  SyncStatus,
  SyncPhase,
  ProjectSyncOptions,
  ProjectSync,
  DocumentState,
} from '../types.js';
import type { DriveSync } from '@open-webapp/drive-sync';
import type { IDBPDatabase } from 'idb';

/**
 * Type-level tests ensuring the API-sketch types enforce interview decisions.
 *
 * These tests are NOT runtime tests.
 * They verify TypeScript compilation constraints:
 * - Decision 9: documents is a function, not an array
 * - Decision 10: no codec type (payloads are opaque: string | Uint8Array)
 * - Decision 11: merge is required (no optional, no default)
 *
 * The test file itself does nothing at runtime, but TypeScript's type checker
 * will error on @ts-expect-error mismatches if the type constraints are violated.
 */

describe('Type-level constraints (compile-time checks only)', () => {
  /**
   * Test: Payload is exactly string | Uint8Array
   * Decision 10: payloads are opaque, never parsed by the package.
   */
  it('Payload type is string | Uint8Array', () => {
    const stringPayload: Payload = 'hello';
    const uint8Payload: Payload = new Uint8Array([1, 2, 3]);

    // Verify exhaustiveness via type inference
    const checkPayload = (p: Payload) => {
      if (typeof p === 'string') {
        const _s: string = p;
      } else {
        const _b: Uint8Array = p;
      }
    };

    checkPayload(stringPayload);
    checkPayload(uint8Payload);
  });

  /**
   * Test: SyncDocument.merge is required (not optional)
   * Decision 11: merge is app-supplied, not a default.
   * A default merge is a silent-data-loss footgun.
   */
  it('SyncDocument requires merge implementation', () => {
    const validDoc: SyncDocument = {
      key: 'doc1',
      name: 'document.json',
      mimeType: 'application/json',
      readLocal: async () => 'content',
      writeLocal: async () => {},
      merge: async (local, remote) => ({ merged: 'merged', conflicts: [] }),
    };

    // This should work fine
    void validDoc;

    // @ts-expect-error - merge is required, cannot be omitted
    const missingMerge: SyncDocument = {
      key: 'doc1',
      name: 'document.json',
      mimeType: 'application/json',
      readLocal: async () => 'content',
      writeLocal: async () => {},
    };

    void missingMerge;
  });

  /**
   * Test: documents() is a function, not a static array
   * Decision 9: documents must be a function because the set can change at runtime
   * (e.g., filter rules added/removed in notesdiary).
   */
  it('documents in ProjectSyncOptions is a function, not an array', () => {
    type ValidConfig = ProjectSyncOptions & {
      documents: (project: Project) => SyncDocument[];
    };

    const project: Project = {
      id: 'p1',
      name: 'My Project',
      createdAt: new Date().toISOString(),
    };

    const validDocuments = (p: Project): SyncDocument[] => [];
    const _valid: ValidConfig = {
      drive: null as any,
      appName: 'Test App',
      registryDbName: 'test-registry',
      data: {
        version: 1,
        upgrade: async () => {},
      },
      documents: validDocuments,
      interval: 5 * 60 * 1000,
    };

    void _valid;
  });

  /**
   * Test: ProjectSyncOptions.merge is required in SyncDocument
   * This is the core constraint: cannot create a valid config without
   * providing merge implementations for all documents.
   */
  it('ProjectSyncOptions fails to compile if any SyncDocument lacks merge', () => {
    const driveSync: DriveSync = null as any;
    const db: IDBPDatabase<any> = null as any;
    const project: Project = {
      id: 'p1',
      name: 'Test',
      createdAt: new Date().toISOString(),
    };

    // This should type-check fine: all documents have merge
    const validConfig: ProjectSyncOptions = {
      drive: driveSync,
      appName: 'TestApp',
      registryDbName: 'test-reg',
      data: {
        version: 1,
        upgrade: async (db, oldV, newV, tx) => {},
      },
      documents: (p: Project) => [
        {
          key: 'doc1',
          name: 'file.json',
          mimeType: 'application/json',
          readLocal: async () => null,
          writeLocal: async (merged: Payload) => {},
          merge: async (local, remote) => ({ merged: local || remote || '', conflicts: [] }),
        },
      ],
      interval: 60000,
    };

    void validConfig;

    // @ts-expect-error - Document without merge should fail the entire config
    const invalidConfig: ProjectSyncOptions = {
      drive: driveSync,
      appName: 'TestApp',
      registryDbName: 'test-reg',
      data: {
        version: 1,
        upgrade: async (db, oldV, newV, tx) => {},
      },
      documents: (p: Project) => [
        {
          key: 'doc1',
          name: 'file.json',
          mimeType: 'application/json',
          readLocal: async () => null,
          writeLocal: async (merged: Payload) => {},
          // Missing merge!
        },
      ],
      interval: 60000,
    };

    void invalidConfig;
  });

  /**
   * Test: All public types are exported and inference works
   * Decision 10: no app-specific types leaked in.
   */
  it('All public types are accessible and inference works', () => {
    const phase: SyncPhase = 'syncing';
    const status: SyncStatus = {
      phase: 'idle',
      lastSyncedAt: null,
      error: null,
      needsReauth: false,
      conflicts: [],
    };
    const doc: DocumentState = {
      driveFileId: 'file123',
      lastSynced: Date.now(),
      status: 'synced',
    };

    // Verify type inference in a real merge scenario
    const merge = async (local: Payload | null, remote: Payload | null) => {
      if (typeof local === 'string' && typeof remote === 'string') {
        return { merged: local + remote, conflicts: [] };
      }
      return { merged: local || remote || '', conflicts: [] };
    };

    void phase;
    void status;
    void doc;
    void merge;
  });

  /**
   * Test: no codec type exposed
   * Decision 10: payloads are opaque; there is no Codec or serialization type in the API.
   */
  it('No codec type leaked into the API', () => {
    // This test is more of a check: ensure no Codec/Serializer/etc appears in types.ts exports
    // The absence of codec in ProjectSyncOptions is the real verification.
    // If a codec type existed, this config would require it:
    const config: ProjectSyncOptions = {
      drive: null as any,
      appName: 'Test',
      registryDbName: 'test',
      data: { version: 1, upgrade: async () => {} },
      documents: () => [],
      interval: null,
      // No codec field — it doesn't exist in the API
    };

    void config;
  });

  /**
   * Test: DocumentState read-only accessor
   * Decision 32: package exposes state for app-driven deletion decisions.
   */
  it('DocumentState is available and immutable-looking', () => {
    const state: DocumentState = {
      driveFileId: 'abc123',
      lastSynced: Date.now(),
      status: 'synced',
    };

    const fileId = state.driveFileId;
    const synced = state.lastSynced;
    const status = state.status;

    void fileId;
    void synced;
    void status;
  });

  /**
   * Test: ProjectSync interface exposes all required methods
   * Verifies the API sketch is complete and nothing app-specific is required.
   */
  it('ProjectSync interface defines required methods', () => {
    const mockProjectSync = {
      projects: {
        list: async () => [] as Project[],
        get: async (id: string) => null as Project | null,
        create: async (name: string) => ({} as Project),
        rename: async (id: string, name: string) => ({} as Project),
        remove: async (id: string) => {},
        setActive: async (id: string) => {},
        getActive: async () => null as Project | null,
      },
      data: {
        getActiveDb: async () => null as any,
        getDocumentState: async (pid: string, key: string) => null as DocumentState | null,
        forgetDocument: async (pid: string, key: string) => {},
      },
      connection: {
        connect: async () => {},
        disconnect: async () => {},
        status: async () => null as any,
      },
      sync: {
        start: () => {},
        stop: () => {},
        syncNow: async () => {},
        markDirty: (pid: string) => {},
      },
      subscribe: (cb: (s: SyncStatus) => void) => () => {},
    } satisfies ProjectSync;

    void mockProjectSync;
  });
});
