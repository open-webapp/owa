/**
 * Payload conversion utilities for bridge between drive-sync and project-sync type systems.
 *
 * drive-sync returns `string | Blob | null` for file content.
 * project-sync works with `Payload` which is `string | Uint8Array`.
 *
 * These utilities convert between the two systems seamlessly.
 */

import type { Payload } from './types.js';

/**
 * Convert a Blob to Uint8Array.
 *
 * Used when drive-sync returns a Blob (binary file) and we need to work with Payload.
 *
 * @param blob - The Blob to convert
 * @returns Promise resolving to Uint8Array
 * @throws If Blob.arrayBuffer() fails
 */
export async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Convert Uint8Array to Blob.
 *
 * Used when we have a Payload (Uint8Array) and need to write it via drive-sync.
 *
 * @param data - The Uint8Array to convert
 * @param mimeType - MIME type for the Blob
 * @returns Blob with the given MIME type
 */
export function uint8ArrayToBlob(data: Uint8Array, mimeType: string): Blob {
  return new Blob([data], { type: mimeType });
}

/**
 * Normalize drive-sync output to Payload type.
 *
 * Converts `string | Blob | null` (from drive-sync) to `Payload | null` (string | Uint8Array | null).
 *
 * - String → String (no conversion)
 * - Blob → Uint8Array (async conversion via arrayBuffer)
 * - null → null (no conversion)
 *
 * @param content - Content from drive-sync (string | Blob | null)
 * @param _mimeType - MIME type hint (not used in conversion, provided for symmetry)
 * @returns Promise resolving to Payload or null
 * @throws If Blob.arrayBuffer() fails
 */
export async function normalizeFromDrive(
  content: string | Blob | null,
  _mimeType?: string
): Promise<Payload | null> {
  if (content === null) return null;
  if (typeof content === 'string') return content;
  // Blob case
  return await blobToUint8Array(content);
}

/**
 * Convert Payload to drive-sync input format.
 *
 * Converts `string | Uint8Array` (Payload) to `string | Blob` (drive-sync input).
 *
 * - String → String (no conversion)
 * - Uint8Array → Blob (sync conversion with mimeType)
 *
 * @param payload - The Payload to convert
 * @param mimeType - MIME type for the resulting Blob (required for Uint8Array)
 * @returns String or Blob ready for drive-sync
 */
export function normalizeToDrive(payload: Payload | null, mimeType: string): string | Blob {
  if (payload === null) return '';
  if (typeof payload === 'string') return payload;
  // Uint8Array case
  return uint8ArrayToBlob(payload, mimeType);
}
