import { describe, it, expect } from 'vitest';
import { getOrganizerLabel } from '../events.js';
import { makeEvent } from '../../react/__tests__/helpers.js';

describe('getOrganizerLabel with resolver', () => {
  const r = (e: string) => (e === 'o@x.com' ? { name: 'Olive Oyl' } : undefined);
  it('contact name beats displayName and email', () => {
    const ev = makeEvent({ organizer: { displayName: 'Olive', email: 'o@x.com', self: false } });
    expect(getOrganizerLabel(ev, r)).toBe('Olive Oyl');
  });
  it('falls back when resolver returns nothing', () => {
    const ev = makeEvent({ organizer: { displayName: 'Zed', email: 'z@x.com', self: false } });
    expect(getOrganizerLabel(ev, r)).toBe('Zed');
  });
  it('resolved name beats "You" for self organizer; "You" kept when unresolved', () => {
    const ev = makeEvent({ organizer: { email: 'o@x.com', self: true } });
    expect(getOrganizerLabel(ev, r)).toBe('Olive Oyl');
    expect(getOrganizerLabel(makeEvent({ organizer: { self: true } }), r)).toBe('You');
  });
});
