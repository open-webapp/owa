import type { CryptoAdapter, StorageAdapter, StorageRow } from '../core/storage.js';

export function createMemoryStorage(): StorageAdapter & { rows: Map<string, StorageRow> } {
  const rows = new Map<string, StorageRow>();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async put(id, row) {
      rows.set(id, row);
    },
    async delete(id) {
      rows.delete(id);
    },
    async clear(id) {
      rows.delete(id);
    },
  };
}

export const identityCrypto: CryptoAdapter = {
  encrypt: async (s) => s,
  decrypt: async (s) => s,
};

export type FakeReply = { status: number; body?: unknown } | 'network-error';

/** Stubs global fetch with a router; returns the request log. Restore via the returned `restore`. */
export function installFakeFetch(
  router: (req: { url: string; token: string }, u: URL) => FakeReply,
): { log: { url: string; token: string }[]; restore: () => void } {
  const original = globalThis.fetch;
  const log: { url: string; token: string }[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? '';
    const req = { url, token: auth.replace(/^Bearer /, '') };
    log.push(req);
    const reply = router(req, new URL(url));
    if (reply === 'network-error') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { log, restore: () => void (globalThis.fetch = original) };
}
export * from './storageContract.js';
