process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventDetails } from '../EventDetails.js';
import { makeEvent } from './helpers.js';

function setup(resolveContact?: (email: string) => { name?: string; photoUrl?: string } | undefined, overrides = {}) {
  const event = makeEvent({
    summary: 'Planning',
    organizer: { displayName: 'Olive', email: 'olive@x.com', self: false },
    attendees: [
      { email: 'ann@x.com', displayName: 'Ann', responseStatus: 'accepted' },
      { email: 'bob@x.com', responseStatus: 'accepted' },
    ],
    ...overrides,
  });
  return render(
    <EventDetails event={event} sourceLabel="" onClose={vi.fn()} onOpenLink={vi.fn()} resolveContact={resolveContact} />,
  );
}

describe('EventDetails resolveContact', () => {
  it('contact name overrides displayName and email on invitee rows', () => {
    setup((e) => (e === 'ann@x.com' ? { name: 'Ann Lovelace' } : e === 'bob@x.com' ? { name: 'Bob Builder' } : undefined));
    expect(screen.getByText('Ann Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Bob Builder')).toBeInTheDocument();
    expect(screen.queryByText('Ann')).toBeNull();
  });

  it('contact name overrides organizer label in the organizer row', () => {
    setup((e) => (e === 'olive@x.com' ? { name: 'Olive Oyl' } : undefined), { attendees: [] });
    expect(screen.getByText('Olive Oyl')).toBeInTheDocument();
    expect(screen.queryByText('Olive')).toBeNull();
  });

  it('photoUrl renders an avatar img', () => {
    const { container } = setup((e) => (e === 'ann@x.com' ? { name: 'Ann L', photoUrl: 'https://img.example/a.png' } : undefined));
    const imgs = container.querySelectorAll('img.calendar-event-details-avatar');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute('src', 'https://img.example/a.png');
  });

  it('name only renders no avatar', () => {
    const { container } = setup(() => ({ name: 'Zed' }));
    expect(container.querySelector('img')).toBeNull();
  });

  it('undefined result falls back to displayName/email', () => {
    setup(() => undefined);
    expect(screen.getByText('Ann')).toBeInTheDocument();
    expect(screen.getByText('bob@x.com')).toBeInTheDocument();
  });

  it('resolver receives the attendee email as given', () => {
    const seen: string[] = [];
    setup((e) => (seen.push(e), undefined), { attendees: [{ email: 'MiXed@X.com', responseStatus: 'accepted' }, { email: 'b@x.com', responseStatus: 'accepted' }] });
    expect(seen).toContain('MiXed@X.com');
  });

  it('absent prop renders identical DOM to resolver returning undefined', () => {
    const a = setup(undefined).container.innerHTML;
    const b = setup(() => undefined).container.innerHTML;
    expect(a).toBe(b);
  });
});
