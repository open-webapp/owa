process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventDetails } from '../EventDetails.js';
import { makeEvent } from './helpers.js';
import type { CalendarInfo } from '../../core/types.js';

const CAL: CalendarInfo = { id: 'c1', summary: 'Work', primary: false, accessRole: 'owner', backgroundColor: '#f00' };

function setup(overrides = {}, props = {}) {
  const onClose = vi.fn();
  const onOpenLink = vi.fn();
  const event = makeEvent({
    summary: 'Planning',
    joinUrl: 'https://meet.example.com/x',
    organizer: { displayName: 'Olive', self: false },
    location: 'Room 4',
    description: 'Agenda https://example.com/doc',
    attendees: [{ email: 'a@x.com', displayName: 'Ann', responseStatus: 'accepted' }],
    ...overrides,
  });
  const utils = render(
    <EventDetails event={event} calendar={CAL} sourceLabel="me@example.com" onClose={onClose} onOpenLink={onOpenLink} {...props} />,
  );
  return { onClose, onOpenLink, ...utils };
}

describe('EventDetails', () => {
  it('renders sections in order with Join attrs and open link', async () => {
    const { onOpenLink, container } = setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const text = dialog.textContent ?? '';
    const order = ['Planning', 'Work', 'me@example.com', 'Olive', 'Join', 'Accepted', 'Room 4', 'Agenda', 'Ann'];
    let last = -1;
    for (const s of order) {
      const i = text.indexOf(s, last + 1);
      expect(i, s).toBeGreaterThan(last);
      last = i;
    }
    const join = screen.getByRole('link', { name: 'Join' });
    expect(join).toHaveAttribute('target', '_blank');
    expect(join).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('.calendar-event-details')).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: /open in google calendar/i }));
    expect(onOpenLink).toHaveBeenCalledWith('https://calendar.google.com/event?eid=evt-1');
  });

  it('omits absent sections', () => {
    setup({ htmlLink: '', location: undefined, description: undefined, attendees: undefined });
    expect(screen.queryByRole('link', { name: /open in google calendar/i })).toBeNull();
    expect(screen.queryByText('Room 4')).toBeNull();
    expect(screen.queryByText(/more/)).toBeNull();
    expect(screen.queryByText('Ann')).toBeNull();
  });

  it('caps attendees at 10', () => {
    const attendees = Array.from({ length: 12 }, (_, i) => ({
      email: `p${i}@x.com`, displayName: `Person${i}`, responseStatus: 'accepted' as const,
    }));
    setup({ attendees });
    expect(screen.getByText('Person9')).toBeInTheDocument();
    expect(screen.queryByText('Person10')).toBeNull();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('closes on Esc, backdrop, X but not sheet click', async () => {
    const { onClose, container } = setup();
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(container.querySelector('.calendar-event-details') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('moves focus in and traps Tab', async () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 12; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('renders description as plain text only', () => {
    setup({ description: '<img src=x onerror=alert(1)>hi<script>1</script>' });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/hi/)).toBeInTheDocument();
    expect(dialog.querySelector('img,script')).toBeNull();
  });
});
