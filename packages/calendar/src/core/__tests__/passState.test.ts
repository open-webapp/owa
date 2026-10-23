import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pkg from '../../index.js';
import { createCalendarController } from '../controller.js';

const crypto = { encrypt: async (s: string) => s, decrypt: async (s: string) => s };
const NOW = new Date('2026-01-31T00:00:00Z');
const A = { id: 'a', email: 'a@x.com' };

function memStorage() {
  const rows = new Map<string, any>();
  return {
    get: async (id: string) => rows.get(id) ?? null,
    put: async (id: string, r: any) => void rows.set(id, r),
    delete: async (id: string) => void rows.delete(id),
    clear: async (id: string) => void rows.delete(id),
  };
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const calList = () => json({ items: [
  { id: 'primary', summary: 'primary', primary: true, accessRole: 'owner' },
  { id: 'extra', summary: 'extra', accessRole: 'owner' },
] });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('pass state', () => {
  it('publishes loading=true mid-pass and false after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith('/calendarList')) return calList();
      await gate;
      return json({ items: [], nextSyncToken: 'T' });
    }));
    const c = createCalendarController({ sources: [A], getToken: async () => 't', storage: memStorage(), crypto, now: () => NOW });
    const seen: boolean[] = [];
    c.subscribe(() => seen.push(c.getState().loading));
    const p = c.refresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain(true);
    expect(c.getState().loading).toBe(true);
    release();
    await p;
    expect(c.getState().loading).toBe(false);
  });

  it('partial selection pass does not clear deferred from a full pass', async () => {
    let defer = true;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith('/calendarList')) return calList();
      return json({ items: [], nextSyncToken: 'T' });
    }));
    const getToken = vi.fn(async () => {
      if (defer) throw new (pkg as any).RefreshDeferredError('d');
      return 't';
    });
    const c = createCalendarController({ sources: [A], getToken, storage: memStorage(), crypto, now: () => NOW });
    await c.refresh();
    expect(c.getState().deferred).toBe(true);
    defer = false;
    await c.setSelectedIds('a', ['primary', 'extra']);
    expect(c.getState().deferred).toBe(true);
    await c.refresh();
    expect(c.getState().deferred).toBe(false);
  });
});
