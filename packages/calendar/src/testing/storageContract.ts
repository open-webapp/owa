import { describe, expect, it } from 'vitest';
import { createCalendarController } from '../core/controller.js';
import type { CryptoAdapter, StorageAdapter, StorageRow } from '../core/storage.js';
import type { CalendarEvent } from '../core/types.js';
import { installFakeFetch } from './index.js';

/**
 * What a host supplies to run the contract.
 *
 * - `storage` / `crypto`: the adapters under test (fresh, empty per factory call).
 * - `seedRaw` (optional): writes a row EXACTLY as given, bypassing any normalisation the
 *   adapter's `put` performs. Hosts whose adapter stores a different on-disk shape (e.g. an
 *   IndexedDB store) use this to plant legacy-format and corrupt rows. Defaults to `storage.put`.
 * - `wrongKeyCrypto` (optional): a crypto adapter whose decrypt fails (or yields garbage) for
 *   data written by `crypto`. Omit when `crypto` is an identity transform (wrong-key case skipped).
 * - `encryptedFixture` (optional): a LITERAL ciphertext string (copied from a real legacy
 *   capture, never generated here) that `crypto.decrypt` turns into JSON of `[LEGACY_EVENT]`.
 *   Defaults to the plain JSON string, which is correct for identity crypto.
 * - `corruptRow` (optional): a row the host considers corrupt on disk. Defaults to garbage strings.
 */
export interface StorageContractHarness {
  storage: StorageAdapter;
  crypto: CryptoAdapter;
  seedRaw?: (sourceId: string, row: StorageRow) => Promise<void>;
  wrongKeyCrypto?: CryptoAdapter;
  encryptedFixture?: string;
  corruptRow?: StorageRow;
}

/** Literal fixture event (values copied from the notesdiary calendarCache test row()). */
export const LEGACY_EVENT: CalendarEvent = {
  id: 'instanceId',
  sourceId: 'src',
  calendarId: 'cal',
  summary: 'Original',
  start: { dateTime: '2026-10-09T15:00:00.000Z' },
  end: { dateTime: '2026-10-09T16:00:00.000Z' },
  isAllDay: false,
  selfResponseStatus: 'accepted',
  joinUrl: null,
  organizer: { self: false },
  htmlLink: '',
};

const LEGACY_JSON = '[{"id":"instanceId","sourceId":"src","calendarId":"cal","summary":"Original","start":{"dateTime":"2026-10-09T15:00:00.000Z"},"end":{"dateTime":"2026-10-09T16:00:00.000Z"},"isAllDay":false,"selfResponseStatus":"accepted","joinUrl":null,"organizer":{"self":false},"htmlLink":""}]';

export function runStorageAdapterContract(factory: () => StorageContractHarness | Promise<StorageContractHarness>): void {
  describe('StorageAdapter contract', () => {
    const ev = (id: string): CalendarEvent => ({ ...LEGACY_EVENT, id });
    const row = (ids: string[], tokens: Record<string, string>, selectedIds: string[]): StorageRow => ({
      events: ids.map(ev),
      syncState: { tokens },
      selectedIds,
    });

    /** Loads a source through the real controller (network down) and returns what it read back. */
    async function readBack(h: StorageContractHarness, crypto: CryptoAdapter = h.crypto) {
      const f = installFakeFetch(() => 'network-error');
      try {
        const c = createCalendarController({
          sources: [{ id: 'src', email: 'a@b.c' }],
          getToken: async () => 't',
          storage: h.storage,
          crypto,
        });
        await c.refresh();
        return { events: c.getEvents(), selected: c.getSelectedIds('src') };
      } finally {
        f.restore();
      }
    }
    const seed = (h: StorageContractHarness, id: string, r: StorageRow) =>
      (h.seedRaw ?? ((i, x) => h.storage.put(i, x)))(id, r);

    it('put/get round-trips events, syncState and selectedIds', async () => {
      const { storage } = await factory();
      const r = row(['a', 'b'], { cal: 'tok' }, ['cal']);
      await storage.put('s1', r);
      expect(await storage.get('s1')).toEqual(r);
    });

    it('isolates sources from each other', async () => {
      const { storage } = await factory();
      await storage.put('s1', row(['a'], { c: '1' }, ['c']));
      await storage.put('s2', row(['b'], { c: '2' }, []));
      await storage.delete('s1');
      expect(await storage.get('s1')).toBeNull();
      expect(await storage.get('s2')).toEqual(row(['b'], { c: '2' }, []));
    });

    it('delete and clear remove only the given source', async () => {
      const { storage } = await factory();
      await storage.put('s1', row(['a'], {}, []));
      await storage.put('s2', row(['b'], {}, []));
      await storage.clear('s1');
      expect(await storage.get('s1')).toBeNull();
      expect(await storage.get('s2')).not.toBeNull();
      await storage.delete('s2');
      expect(await storage.get('s2')).toBeNull();
    });

    it('get on a missing source resolves null', async () => {
      const { storage } = await factory();
      expect(await storage.get('nope')).toBeNull();
    });

    it('missing source reads back as empty', async () => {
      const h = await factory();
      expect(await readBack(h)).toEqual({ events: [], selected: ['primary'] });
    });

    it('reads a legacy plain (unencrypted) row', async () => {
      const h = await factory();
      await seed(h, 'src', { events: [LEGACY_EVENT], syncState: { tokens: { cal: 't' } }, selectedIds: ['cal'] });
      expect(await readBack(h)).toEqual({ events: [LEGACY_EVENT], selected: ['cal'] });
    });

    it('reads a legacy encrypted row from a literal fixture', async () => {
      const h = await factory();
      await seed(h, 'src', {
        events: h.encryptedFixture ?? LEGACY_JSON,
        syncState: h.encryptedFixture ? null : '{"tokens":{"cal":"t"}}',
        selectedIds: ['cal'],
      });
      const out = await readBack(h);
      expect(out.events).toEqual([LEGACY_EVENT]);
      expect(out.selected).toEqual(['cal']);
    });

    it('reads a 0.1.0 row that has no lastFullSyncAt/lastSyncAt fields', async () => {
      const h = await factory();
      await seed(h, 'src', { events: [LEGACY_EVENT], syncState: { tokens: { cal: 't' } }, selectedIds: ['cal'] });
      const out = await readBack(h);
      expect(out.events).toEqual([LEGACY_EVENT]);
      expect(out.selected).toEqual(['cal']);
    });

    it('a corrupt row reads back empty without throwing', async () => {
      const h = await factory();
      await seed(h, 'src', h.corruptRow ?? { events: '%%not-json%%', syncState: '{{', selectedIds: 'bad' as unknown as string[] });
      await expect(readBack(h)).resolves.toEqual({ events: [], selected: ['primary'] });
    });

    it('a wrong key reads back empty without throwing', async () => {
      const h = await factory();
      if (!h.wrongKeyCrypto) return;
      await h.storage.put('src', {
        events: await h.crypto.encrypt(JSON.stringify([LEGACY_EVENT])),
        syncState: await h.crypto.encrypt(JSON.stringify({ tokens: {} })),
        selectedIds: [],
      });
      await expect(readBack(h, h.wrongKeyCrypto)).resolves.toEqual({ events: [], selected: ['primary'] });
    });
  });
}
