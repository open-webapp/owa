import type { CalendarEvent } from './types.js';

export interface SyncState {
  /** Per-calendar incremental sync tokens. */
  tokens: Record<string, string>;
}

/** Persisted per-source row. `events` is an encrypted JSON string when written by the controller. */
export interface StorageRow {
  events: CalendarEvent[] | string | unknown[];
  syncState: SyncState | string | null | unknown;
  selectedIds: string[];
}

export interface StorageAdapter {
  get(sourceId: string): Promise<StorageRow | null>;
  put(sourceId: string, row: StorageRow): Promise<void>;
  delete(sourceId: string): Promise<void>;
  clear(sourceId: string): Promise<void>;
}

export interface CryptoAdapter {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
