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
    const order = ['9:00', 'Join', 'Planning', 'Work', 'me@example.com', 'Room 4', 'Agenda'];
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
    setup({ isAllDay: true, joinUrl: undefined, location: undefined, attendees: undefined, organizer: { displayName: 'Olive', self: true } });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('All day');
    expect(screen.queryByRole('link', { name: 'Join' })).toBeNull();
    expect(screen.queryByText('Room 4')).toBeNull();
    expect(dialog.querySelector('.calendar-event-details-organizer')?.textContent).toContain('(you)');
  });

  it('top row has no status glyph but keeps the rsvp class and Join', () => {
    setup();
    const row = document.querySelector('.calendar-event-details-toprow') as HTMLElement;
    expect(row.querySelector('.calendar-event-rsvp')).toBeNull();
    expect(row).toHaveClass('calendar-event-row--rsvp-accepted');
    expect(row.querySelector('a.calendar-event-join')).not.toBeNull();
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

  it('drops the top Organizer row when the invitee list is shown; statuses use the card icon', () => {
    const { container } = setup({ attendees: four });
    expect(container.querySelector('.calendar-event-details-organizer')).toBeNull();
    const item = screen.getAllByRole('listitem')[0];
    expect(item.querySelector('.calendar-event-rsvp.calendar-event-rsvp--accepted')).not.toBeNull();
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
    const note = () => screen.queryByLabelText('Note to organizer (optional)') as HTMLInputElement | null;
    const send = () => screen.queryByRole('button', { name: 'Send' });
    const pick = (n: string) => userEvent.click(screen.getByRole('radio', { name: n }));

    it('click Maybe only selects: no call, note + Send appear; current is checked first', async () => {
      const onRsvpChange = vi.fn();
      setup({ attendees: four }, { onRsvpChange });
      expect(screen.getByRole('radiogroup', { name: 'Change RSVP' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'true');
      expect(note()).toBeNull();
      await pick('Maybe');
      expect(onRsvpChange).not.toHaveBeenCalled();
      expect(note()).not.toBeNull();
      expect(send()).not.toBeNull();
      expect(screen.getByRole('radio', { name: 'Maybe' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.queryByRole('radio', { name: /unaccepted|awaiting/i })).toBeNull();
    });

    it('Send writes once with status and note', async () => {
      const onRsvpChange = vi.fn();
      setup({ attendees: four }, { onRsvpChange });
      await pick('Maybe');
      await userEvent.type(note()!, 'late 10m');
      await userEvent.click(send()!);
      expect(onRsvpChange).toHaveBeenCalledTimes(1);
      expect(onRsvpChange.mock.calls[0][1]).toBe('tentative');
      expect(onRsvpChange.mock.calls[0][2]).toBe('late 10m');
    });

    it('note is trimmed; empty or whitespace-only becomes undefined', async () => {
      const onRsvpChange = vi.fn();
      setup({ attendees: four }, { onRsvpChange });
      await pick('Maybe');
      await userEvent.click(send()!);
      expect(onRsvpChange.mock.calls[0][2]).toBeUndefined();
      await userEvent.type(note()!, '  hi  ');
      await userEvent.click(send()!);
      expect(onRsvpChange.mock.calls[1][2]).toBe('hi');
      await userEvent.clear(note()!);
      await userEvent.type(note()!, '   ');
      await userEvent.click(send()!);
      expect(onRsvpChange.mock.calls[2][2]).toBeUndefined();
    });

    it('switching status keeps the typed note', async () => {
      const onRsvpChange = vi.fn();
      setup({ attendees: four }, { onRsvpChange });
      await pick('Maybe');
      await userEvent.type(note()!, 'hello');
      await pick('No');
      expect(note()!.value).toBe('hello');
      await userEvent.click(send()!);
      expect(onRsvpChange.mock.calls[0].slice(1)).toEqual(['declined', 'hello']);
    });

    it('re-clicking the saved status cancels the draft', async () => {
      const onRsvpChange = vi.fn();
      setup({ attendees: four }, { onRsvpChange });
      await pick('Maybe');
      await pick('Yes');
      expect(note()).toBeNull();
      expect(send()).toBeNull();
      expect(onRsvpChange).not.toHaveBeenCalled();
    });

    it('Escape in the note field cancels without closing; Escape elsewhere closes', async () => {
      const onRsvpChange = vi.fn();
      const { onClose } = setup({ attendees: four }, { onRsvpChange });
      await pick('Maybe');
      note()!.focus();
      await userEvent.keyboard('{Escape}');
      expect(note()).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(onRsvpChange).not.toHaveBeenCalled();
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('note input is single-line with maxLength 500', async () => {
      setup({ attendees: four }, { onRsvpChange: vi.fn() });
      await pick('Maybe');
      expect(note()).toHaveAttribute('maxlength', '500');
      expect(note()!.tagName).toBe('INPUT');
    });

    it('pending disables radios and Send and shows live text', async () => {
      const onRsvpChange = vi.fn();
      const { rerender, onClose, onOpenLink, container } = setup({ attendees: four }, { onRsvpChange });
      await pick('Maybe');
      const event = makeEvent({ attendees: four, joinUrl: 'https://meet.example.com/x' });
      rerender(
        <EventDetails event={event} calendar={CAL} sourceLabel="s" onClose={onClose} onOpenLink={onOpenLink} onRsvpChange={onRsvpChange} pending />,
      );
      expect(container).toBeTruthy();
      screen.getAllByRole('radio').forEach((r) => expect(r).toBeDisabled());
      expect(send()).toBeDisabled();
      expect(screen.getByText('Updating RSVP...')).toBeInTheDocument();
      await userEvent.click(send()!);
      expect(onRsvpChange).not.toHaveBeenCalled();
    });

    it('success (pending then not pending, no error) hides note + Send and clears the draft', async () => {
      const onRsvpChange = vi.fn();
      const { rerender, onClose, onOpenLink } = setup({ attendees: four }, { onRsvpChange });
      await pick('Maybe');
      await userEvent.type(note()!, 'x');
      await userEvent.click(send()!);
      const ev = (st: string) => makeEvent({ attendees: four, selfResponseStatus: st as never });
      const r = (e: ReturnType<typeof ev>, pending: boolean) =>
        rerender(<EventDetails event={e} calendar={CAL} sourceLabel="s" onClose={onClose} onOpenLink={onOpenLink} onRsvpChange={onRsvpChange} pending={pending} />);
      r(ev('tentative'), true);
      r(ev('tentative'), false);
      expect(note()).toBeNull();
      expect(send()).toBeNull();
      expect(screen.getByRole('radio', { name: 'Maybe' })).toHaveAttribute('aria-checked', 'true');
      await pick('No');
      expect(note()!.value).toBe('');
    });

    it('hidden without handler or when not invited', () => {
      const { unmount } = setup({ attendees: four });
      expect(screen.queryByRole('radiogroup')).toBeNull();
      unmount();
      setup({ attendees: four.slice(1) }, { onRsvpChange: vi.fn() });
      expect(screen.queryByRole('radiogroup')).toBeNull();
    });

    it('invitee rows keep glyphs', () => {
      setup({ attendees: four }, { onRsvpChange: vi.fn() });
      expect(screen.getAllByRole('listitem')[0].querySelector('.calendar-event-rsvp')).not.toBeNull();
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

    it('error shows exact text, keeps draft; Retry resends same status + note', async () => {
      const onRsvpChange = vi.fn();
      const { rerender, onClose, onOpenLink } = setup({ attendees: four }, { onRsvpChange });
      await pick('No');
      await userEvent.type(note()!, 'sick');
      await userEvent.click(send()!);
      const event = onRsvpChange.mock.calls[0][0];
      rerender(
        <EventDetails event={event} calendar={CAL} sourceLabel="me@example.com" onClose={onClose} onOpenLink={onOpenLink} onRsvpChange={onRsvpChange} error />,
      );
      expect(screen.getByText(/Couldn't update RSVP\./).parentElement?.textContent).toBe("Couldn't update RSVP. Retry");
      expect(note()!.value).toBe('sick');
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(onRsvpChange).toHaveBeenCalledTimes(2);
      expect(onRsvpChange.mock.calls[1].slice(1)).toEqual(['declined', 'sick']);
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
