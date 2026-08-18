/**
 * Tests for payload conversion utilities.
 *
 * Verifies conversion between drive-sync format (string | Blob) and
 * project-sync format (Payload = string | Uint8Array).
 */

import { describe, it, expect } from 'vitest';
import {
  blobToUint8Array,
  uint8ArrayToBlob,
  normalizeFromDrive,
  normalizeToDrive,
} from '../payloadConvert.js';

describe('payloadConvert - payload conversion utilities', () => {
  describe('blobToUint8Array', () => {
    it('converts Blob to Uint8Array byte-identically', async () => {
      const originalBytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      const blob = new Blob([originalBytes], { type: 'application/octet-stream' });

      const result = await blobToUint8Array(blob);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(originalBytes);
    });

    it('handles empty Blob', async () => {
      const blob = new Blob([], { type: 'application/octet-stream' });

      const result = await blobToUint8Array(blob);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it('handles large Blob (100KB+)', async () => {
      const largeData = new Uint8Array(100 * 1024);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = (i % 256) as any;
      }
      const blob = new Blob([largeData], { type: 'application/octet-stream' });

      const result = await blobToUint8Array(blob);

      expect(result).toEqual(largeData);
    });
  });

  describe('uint8ArrayToBlob', () => {
    it('converts Uint8Array to Blob with correct MIME type', () => {
      const data = new Uint8Array([0x01, 0x02, 0x03]);
      const mimeType = 'application/octet-stream';

      const result = uint8ArrayToBlob(data, mimeType);

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe(mimeType);
    });

    it('preserves bytes when converting Uint8Array to Blob', async () => {
      const originalBytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      const blob = uint8ArrayToBlob(originalBytes, 'application/octet-stream');

      const recovered = new Uint8Array(await blob.arrayBuffer());

      expect(recovered).toEqual(originalBytes);
    });

    it('handles empty Uint8Array', () => {
      const empty = new Uint8Array(0);

      const result = uint8ArrayToBlob(empty, 'application/octet-stream');

      expect(result).toBeInstanceOf(Blob);
      expect(result.size).toBe(0);
    });

    it('handles different MIME types', () => {
      const data = new Uint8Array([0x01, 0x02]);

      const jsonBlob = uint8ArrayToBlob(data, 'application/json');
      expect(jsonBlob.type).toBe('application/json');

      const imageBlob = uint8ArrayToBlob(data, 'image/png');
      expect(imageBlob.type).toBe('image/png');
    });
  });

  describe('normalizeFromDrive', () => {
    it('string passes through unchanged', async () => {
      const input = 'hello world';

      const result = await normalizeFromDrive(input);

      expect(result).toBe(input);
    });

    it('Blob is converted to Uint8Array', async () => {
      const bytes = new Uint8Array([0x01, 0x02, 0x03]);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });

      const result = await normalizeFromDrive(blob);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(bytes);
    });

    it('null becomes null', async () => {
      const result = await normalizeFromDrive(null);

      expect(result).toBeNull();
    });

    it('handles empty Blob', async () => {
      const blob = new Blob([], { type: 'application/octet-stream' });

      const result = await normalizeFromDrive(blob);

      expect(result).toBeInstanceOf(Uint8Array);
      expect((result as Uint8Array).length).toBe(0);
    });
  });

  describe('normalizeToDrive', () => {
    it('string passes through unchanged', () => {
      const input = 'hello world';

      const result = normalizeToDrive(input, 'text/plain');

      expect(typeof result).toBe('string');
      expect(result).toBe(input);
    });

    it('Uint8Array is converted to Blob', () => {
      const input = new Uint8Array([0x01, 0x02, 0x03]);

      const result = normalizeToDrive(input, 'application/octet-stream');

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('application/octet-stream');
    });

    it('null becomes empty string', () => {
      const result = normalizeToDrive(null, 'text/plain');

      expect(result).toBe('');
    });

    it('Blob conversion preserves bytes', async () => {
      const originalBytes = new Uint8Array([0xff, 0xfe, 0x01, 0x00]);

      const blob = normalizeToDrive(originalBytes, 'application/octet-stream');

      const recovered = new Uint8Array(await (blob as Blob).arrayBuffer());
      expect(recovered).toEqual(originalBytes);
    });

    it('respects MIME type in Blob conversion', () => {
      const input = new Uint8Array([0x01]);

      const jsonBlob = normalizeToDrive(input, 'application/json');
      expect((jsonBlob as Blob).type).toBe('application/json');

      const csvBlob = normalizeToDrive(input, 'text/csv');
      expect((csvBlob as Blob).type).toBe('text/csv');
    });
  });

  describe('round-trip conversions', () => {
    it('string → drive → string is lossless', async () => {
      const original = 'test content';

      const toDrive = normalizeToDrive(original, 'text/plain');
      const backToPayload = await normalizeFromDrive(toDrive);

      expect(backToPayload).toBe(original);
    });

    it('Uint8Array → drive → Uint8Array is byte-identical', async () => {
      const original = new Uint8Array([0x00, 0x55, 0xaa, 0xff]);

      const toDrive = normalizeToDrive(original, 'application/octet-stream');
      const backToPayload = await normalizeFromDrive(toDrive);

      expect(backToPayload).toEqual(original);
    });

    it('Blob → payload → drive → payload is byte-identical', async () => {
      const originalBytes = new Uint8Array([0x01, 0x02, 0x03]);
      const blob = new Blob([originalBytes], { type: 'application/octet-stream' });

      const toPayload = await normalizeFromDrive(blob);
      const backToDrive = normalizeToDrive(toPayload, 'application/octet-stream');
      const backToPayload = await normalizeFromDrive(backToDrive);

      expect(backToPayload).toEqual(originalBytes);
    });
  });

  describe('happy path edge cases', () => {
    it('empty string survives round-trip', async () => {
      const original = '';

      const toDrive = normalizeToDrive(original, 'text/plain');
      const back = await normalizeFromDrive(toDrive);

      expect(back).toBe('');
    });

    it('empty Uint8Array survives round-trip', async () => {
      const original = new Uint8Array(0);

      const toDrive = normalizeToDrive(original, 'application/octet-stream');
      const back = await normalizeFromDrive(toDrive);

      expect(back).toEqual(original);
      expect((back as Uint8Array).length).toBe(0);
    });

    it('null handling is consistent', async () => {
      // null → drive (empty string)
      const toDrive = normalizeToDrive(null, 'text/plain');
      expect(toDrive).toBe('');

      // But normalizeFromDrive(null) → null
      const fromNull = await normalizeFromDrive(null);
      expect(fromNull).toBeNull();
    });
  });
});
