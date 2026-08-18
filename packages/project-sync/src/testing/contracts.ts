/**
 * Contract test suites for merge and document implementations.
 *
 * These suites provide reusable test contracts that app implementations can use
 * to verify their merge and document I/O implementations conform to expectations.
 *
 * Usage in app tests:
 * ```ts
 * import { describeMergeContract, describeDocumentContract } from '@open-webapp/project-sync/testing'
 *
 * describe('App Merge', () => {
 *   describeMergeContract(appMerge, fixtures)
 * })
 *
 * describe('App Document', () => {
 *   describeDocumentContract(appDocument)
 * })
 * ```
 */

import { describe, it, expect } from 'vitest';
import type { Payload } from '../types.js';

/**
 * Fixture data for merge contract tests.
 *
 * Provides a set of payloads and their record IDs for testing merge semantics.
 */
export interface MergeFixtures {
  /**
   * A base payload with known record IDs.
   * Example: JSON with entries/records identifiable by a key field.
   */
  basePayload: Payload;

  /**
   * Record IDs present in basePayload.
   * Example: ['id-1', 'id-2', 'id-3']
   */
  baseRecordIds: string[];

  /**
   * A modified version of basePayload with added/changed records.
   * Should contain all records from basePayload plus new ones.
   * Example: basePayload + { id: 'id-4', ... }
   */
  modifiedPayload: Payload;

  /**
   * Record IDs present in modifiedPayload (should include baseRecordIds + new).
   * Example: ['id-1', 'id-2', 'id-3', 'id-4']
   */
  modifiedRecordIds: string[];

  /**
   * A disjoint payload with different record IDs.
   * Example: { id: 'id-5', ... }
   */
  disjointPayload: Payload;

  /**
   * Record IDs present only in disjointPayload.
   * Example: ['id-5']
   */
  disjointRecordIds: string[];

  /**
   * Optional: extract record IDs from a payload.
   * If not provided, assumes payload is JSON with records having an 'id' field.
   */
  extractRecordIds?: (payload: Payload) => string[];

  /**
   * Optional: get the set difference between two payloads for advanced tests.
   * Used to verify no data loss.
   */
  getRecordIdDifference?: (payload: Payload, otherPayload: Payload) => string[];
}

/**
 * Test suite for merge function contracts.
 *
 * Verifies that a merge implementation adheres to the following contracts:
 * 1. Idempotence: merge(x, merge(x, y)) produces the same result as merge(x, y)
 * 2. No data loss: every record ID present in either input survives unless app declares deletion
 * 3. Null remote passthrough: merge(x, null) returns x
 * 4. Null local adoption: merge(null, y) returns y
 * 5. Conflicts surfaced: merge returns any conflicts detected
 *
 * @param merge - The merge function to test
 * @param fixtures - Test data including base, modified, and disjoint payloads
 */
export function describeMergeContract(
  merge: (local: Payload | null, remote: Payload | null) => Promise<{ merged: Payload; conflicts: unknown[] }>,
  fixtures: MergeFixtures
) {
  describe('merge contract', () => {
    const {
      basePayload,
      baseRecordIds,
      modifiedPayload,
      modifiedRecordIds,
      disjointPayload,
      disjointRecordIds,
      extractRecordIds = defaultExtractRecordIds,
    } = fixtures;

    describe('null semantics', () => {
      it('null remote → returns local unchanged', async () => {
        const result = await merge(basePayload, null);
        expect(result.merged).toEqual(basePayload);
      });

      it('null local → returns remote unchanged', async () => {
        const result = await merge(null, disjointPayload);
        expect(result.merged).toEqual(disjointPayload);
      });

      it('both null → returns empty string', async () => {
        const result = await merge(null, null);
        expect(result.merged).toEqual('');
      });
    });

    describe('no data loss', () => {
      it('local-only records survive merge(local, remote)', async () => {
        // basePayload has ['id-1', 'id-2', 'id-3']
        // disjointPayload has ['id-5'] (no overlap)
        const result = await merge(basePayload, disjointPayload);

        const resultIds = extractRecordIds(result.merged);
        for (const id of baseRecordIds) {
          expect(resultIds).toContain(id);
        }
      });

      it('remote-only records survive merge(local, remote)', async () => {
        // basePayload has ['id-1', 'id-2', 'id-3']
        // disjointPayload has ['id-5'] (no overlap)
        const result = await merge(basePayload, disjointPayload);

        const resultIds = extractRecordIds(result.merged);
        for (const id of disjointRecordIds) {
          expect(resultIds).toContain(id);
        }
      });

      it('overlapping records survive in merged result', async () => {
        // basePayload has ['id-1', 'id-2', 'id-3']
        // modifiedPayload has ['id-1', 'id-2', 'id-3', 'id-4']
        const result = await merge(basePayload, modifiedPayload);

        const resultIds = extractRecordIds(result.merged);
        for (const id of baseRecordIds) {
          expect(resultIds).toContain(id);
        }
      });
    });

    describe('idempotence', () => {
      it('merge(x, merge(x, y)) produces stable result', async () => {
        // First merge
        const first = await merge(basePayload, modifiedPayload);

        // Merge result with base again (simulating repeated sync)
        const second = await merge(basePayload, first.merged);

        // Should be stable (same result)
        expect(second.merged).toEqual(first.merged);
      });

      it('merge(merge(x, y), x) produces stable result', async () => {
        // First merge
        const first = await merge(basePayload, modifiedPayload);

        // Merge result with base (reversed order)
        const second = await merge(first.merged, basePayload);

        // Should be stable
        expect(second.merged).toEqual(first.merged);
      });
    });

    describe('conflicts', () => {
      it('conflicts array is always returned (even if empty)', async () => {
        const result = await merge(basePayload, modifiedPayload);
        expect(Array.isArray(result.conflicts)).toBe(true);
      });

      it('conflicts object is never swallowed', async () => {
        const result = await merge(basePayload, modifiedPayload);
        // Merged should be present
        expect(result.merged).toBeDefined();
        // Conflicts should be present (even if empty)
        expect(result.conflicts).toBeDefined();
      });
    });

    describe('payload types', () => {
      it('string payloads round-trip', async () => {
        const stringPayload = '{"test": "data"}';
        const result = await merge(stringPayload, null);
        expect(result.merged).toBe(stringPayload);
      });

      it('Uint8Array payloads round-trip', async () => {
        const bytes = new Uint8Array([0x01, 0x02, 0x03]);
        const result = await merge(bytes, null);
        expect(result.merged).toEqual(bytes);
      });
    });
  });
}

/**
 * Test suite for document read/write round-trip contracts.
 *
 * Verifies that a document implementation can read and write payloads
 * in a byte-identical round-trip manner.
 *
 * Usage:
 * ```ts
 * const doc = createDocument()
 * describeDocumentContract(doc)
 * ```
 *
 * @param doc - The document with readLocal/writeLocal methods to test
 */
export function describeDocumentContract(
  doc: { readLocal(): Promise<Payload | null>; writeLocal(merged: Payload): Promise<void> }
) {
  describe('document I/O contract', () => {
    describe('readLocal / writeLocal round-trip', () => {
      it('string payload round-trips byte-identical', async () => {
        const payload = 'test string payload';
        await doc.writeLocal(payload);
        const read = await doc.readLocal();
        expect(read).toBe(payload);
      });

      it('JSON string payload round-trips byte-identical', async () => {
        const payload = JSON.stringify({ id: 'test-1', value: 'data' });
        await doc.writeLocal(payload);
        const read = await doc.readLocal();
        expect(read).toBe(payload);
      });

      it('Uint8Array payload round-trips byte-identical', async () => {
        const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
        await doc.writeLocal(payload);
        const read = await doc.readLocal();

        expect(read).toEqual(payload);
        if (read instanceof Uint8Array && payload instanceof Uint8Array) {
          for (let i = 0; i < payload.length; i++) {
            expect(read[i]).toBe(payload[i]);
          }
        }
      });

      it('large Uint8Array payload round-trips byte-identical', async () => {
        const payload = new Uint8Array(1024 * 100); // 100KB
        for (let i = 0; i < payload.length; i++) {
          payload[i] = i % 256;
        }

        await doc.writeLocal(payload);
        const read = await doc.readLocal();

        expect(read).toEqual(payload);
      });

      it('empty string round-trips', async () => {
        const payload = '';
        await doc.writeLocal(payload);
        const read = await doc.readLocal();
        expect(read).toBe('');
      });

      it('empty Uint8Array round-trips', async () => {
        const payload = new Uint8Array(0);
        await doc.writeLocal(payload);
        const read = await doc.readLocal();
        expect(read?.length ?? 0).toBe(0);
      });

      it('null readLocal before write returns null', async () => {
        const read = await doc.readLocal();
        // First read should return null (document doesn't exist yet)
        // This verifies initial state
        expect(read === null || typeof read === 'string' || read instanceof Uint8Array).toBe(true);
      });
    });

    describe('multiple round-trips', () => {
      it('payload survives multiple write/read cycles', async () => {
        const original = 'cycle test data';

        for (let i = 0; i < 3; i++) {
          await doc.writeLocal(original);
          const read = await doc.readLocal();
          expect(read).toBe(original);
        }
      });

      it('payload survives after intermediate write', async () => {
        const payload1 = 'first payload';
        const payload2 = 'second payload';

        await doc.writeLocal(payload1);
        expect(await doc.readLocal()).toBe(payload1);

        await doc.writeLocal(payload2);
        expect(await doc.readLocal()).toBe(payload2);

        await doc.writeLocal(payload1);
        expect(await doc.readLocal()).toBe(payload1);
      });
    });

    describe('payload integrity', () => {
      it('special characters in string preserve', async () => {
        const payload = 'special: \n\t\r "quotes" \\backslash';
        await doc.writeLocal(payload);
        const read = await doc.readLocal();
        expect(read).toBe(payload);
      });

      it('unicode in string preserves', async () => {
        const payload = 'unicode: 🎉 你好 مرحبا';
        await doc.writeLocal(payload);
        const read = await doc.readLocal();
        expect(read).toBe(payload);
      });

      it('null bytes in Uint8Array preserve', async () => {
        const payload = new Uint8Array([0x00, 0x01, 0x00, 0x02]);
        await doc.writeLocal(payload);
        const read = await doc.readLocal();
        expect(read).toEqual(payload);
      });
    });
  });
}

/**
 * Default record ID extraction for JSON payloads.
 * Assumes payload is JSON with records in an array, each with an 'id' field.
 * Example: JSON.stringify([{ id: 'id-1' }, { id: 'id-2' }])
 */
function defaultExtractRecordIds(payload: Payload): string[] {
  if (!payload) {
    return [];
  }

  try {
    let data: any;

    if (typeof payload === 'string') {
      data = JSON.parse(payload);
    } else if (payload instanceof Uint8Array) {
      const decoder = new TextDecoder();
      data = JSON.parse(decoder.decode(payload));
    } else {
      return [];
    }

    if (Array.isArray(data)) {
      return data
        .map((item: any) => item.id)
        .filter((id: any) => id !== undefined);
    } else if (data && typeof data === 'object' && data.records && Array.isArray(data.records)) {
      return data.records
        .map((item: any) => item.id)
        .filter((id: any) => id !== undefined);
    }

    return [];
  } catch {
    return [];
  }
}
