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
  it('renders top row, title, organizer, calendar line, location, description in order', async () => {
    const { onOpenLink, container } = setup({ start: { dateTime: '2026-03-02T09:00:00-08:00' }, end: { dateTime: '2026-03-02T09:30:00-08:00' } });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const text = dialog.textContent ?? '';
    const order = ['9:00', 'Join', 'Planning', 'Organizer', 'Olive', 'Work', 'me@example.com', 'Room 4', 'Agenda'];
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

  it('shows All day, omits Join/location, tags organizer (you)', () => {
    setup({ isAllDay: true, joinUrl: undefined, location: undefined, organizer: { displayName: 'Olive', self: true } });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('All day');
    expect(screen.queryByRole('link', { name: 'Join' })).toBeNull();
    expect(screen.queryByText('Room 4')).toBeNull();
    expect(dialog.querySelector('.calendar-event-details-organizer')?.textContent).toContain('(you)');
  });

  it('top-row status is neither radio nor button', () => {
    setup();
    const status = screen.getByRole('img', { name: 'accepted' });
    expect(status.closest('.calendar-event-details-toprow')).not.toBeNull();
    expect(status).toHaveClass('calendar-event-rsvp', 'calendar-event-rsvp--accepted');
    expect(status.closest('[role="radio"],button')).toBeNull();
  });

  it('top row mirrors the event card markup (header, time, actions, join class)', () => {
    setup({ start: { dateTime: '2026-03-02T09:00:00-08:00' }, end: { dateTime: '2026-03-02T09:30:00-08:00' } });
    const row = document.querySelector('.calendar-event-details-toprow')!;
    expect(row).toHaveClass('calendar-event-header', 'calendar-event-row--rsvp-accepted');
    expect(row.querySelector('.calendar-event-time')).not.toBeNull();
    expect(row.querySelector('.calendar-event-actions a.calendar-event-join')).not.toBeNull();
  });

  it('omits absent sections', () => {
    setup({ htmlLink: '', location: undefined, description: undefined, attendees: undefined });
    expect(screen.queryByRole('link', { name: /open in google calendar/i })).toBeNull();
    expect(screen.queryByText('Room 4')).toBeNull();
    expect(screen.queryByText(/Invitees/)).toBeNull();
  });

  const four = [
    { email: 'me@x.com', displayName: 'Me', responseStatus: 'accepted', self: true },
    { email: 'o@x.com', displayName: 'Olive', responseStatus: 'accepted', organizer: true },
    { email: 'b@x.com', displayName: 'Bob', responseStatus: 'tentative' },
    { email: 'c@x.com', responseStatus: 'needsAction' },
  ];

  it('renders Invitees heading, summary, organizer first, (you) tag, email fallback', () => {
    setup({ attendees: four });
    expect(screen.getByText('Invitees (4)')).toBeInTheDocument();
    expect(screen.getByText('2 yes · 1 maybe · 1 awaiting')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Olive');
    expect(items[0].textContent).toContain('Organizer');
    expect(items[1].textContent).toContain('(you)');
    expect(screen.getByText('c@x.com')).toBeInTheDocument();
  });

  it('caps invitees at 10 with Show all toggle', async () => {
    const attendees = Array.from({ length: 12 }, (_, i) => ({
      email: `p${i}@x.com`, displayName: `Person${String(i).padStart(2, '0')}`, responseStatus: 'accepted' as const,
    }));
    setup({ attendees });
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.queryByText(/more/)).toBeNull();
    const btn = screen.getByRole('button', { name: 'Show all 12' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
  });

  it('hides Invitees for only-self, keeps Organizer; shows for not invited', () => {
    const { unmount } = setup({ attendees: [{ email: 'me@x.com', responseStatus: 'accepted', self: true }] });
    expect(screen.queryByText(/Invitees/)).toBeNull();
    expect(screen.getByText('Olive')).toBeInTheDocument();
    unmount();
    setup({ attendees: four.slice(1) });
    expect(screen.getByText('Invitees (3)')).toBeInTheDocument();
  });

  describe('Change RSVP', () => {
    it('click Maybe calls handler once; current is checked', async () => {
      const onRsvpChange = vi.fn();
      setup({ attendees: four }, { onRsvpChange });
      expect(screen.getByRole('radiogroup', { name: 'Change RSVP' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'true');
      await userEvent.click(screen.getByRole('radio', { name: 'Maybe' }));
      expect(onRsvpChange).toHaveBeenCalledTimes(1);
      expect(onRsvpChange.mock.calls[0][1]).toBe('tentative');
      expect(screen.queryByRole('radio', { name: /unaccepted|awaiting/i })).toBeNull();
    });

    it('pending disables radios and shows live text', async () => {
      const onRsvpChange = vi.fn();
      setup({ attendees: four }, { onRsvpChange, pending: true });
      screen.getAllByRole('radio').forEach((r) => expect(r).toBeDisabled());
      expect(screen.getByText('Updating RSVP...')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('radio', { name: 'No' }));
      expect(onRsvpChange).not.toHaveBeenCalled();
    });

    it('hidden without handler or when not invited', () => {
      const { unmount } = setup({ attendees: four });
      expect(screen.queryByRole('radiogroup')).toBeNull();
      unmount();
      setup({ attendees: four.slice(1) }, { onRsvpChange: vi.fn() });
      expect(screen.queryByRole('radiogroup')).toBeNull();
    });

    it('arrows move focus; Esc closes', async () => {
      const { onClose } = setup({ attendees: four }, { onRsvpChange: vi.fn() });
      screen.getByRole('radio', { name: 'Yes' }).focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(screen.getByRole('radio', { name: 'Maybe' })).toHaveFocus();
      await userEvent.keyboard('{ArrowLeft}');
      expect(screen.getByRole('radio', { name: 'Yes' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalled();
    });

    it('error shows exact text; Retry re-runs last status', async () => {
      const onRsvpChange = vi.fn();
      const { rerender, onClose, onOpenLink } = setup({ attendees: four }, { onRsvpChange });
      await userEvent.click(screen.getByRole('radio', { name: 'No' }));
      const event = onRsvpChange.mock.calls[0][0];
      rerender(
        <EventDetails event={event} calendar={CAL} sourceLabel="me@example.com" onClose={onClose} onOpenLink={onOpenLink} onRsvpChange={onRsvpChange} error />,
      );
      expect(screen.getByText(/Couldn't update RSVP\./).parentElement?.textContent).toBe("Couldn't update RSVP. Retry");
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(onRsvpChange).toHaveBeenCalledTimes(2);
      expect(onRsvpChange.mock.calls[1][1]).toBe('declined');
    });
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
