import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import type { CalendarEvent } from '../../core/types.js';
import { baseProps, makeEvent, type RsvpSelection } from './helpers.js';

const invitations = [
  makeEvent({ id: 'invitation-1', selfResponseStatus: 'needsAction' }),
  makeEvent({ id: 'invitation-2', selfResponseStatus: 'needsAction' }),
  makeEvent({ id: 'invitation-3', selfResponseStatus: 'needsAction' }),
  makeEvent({ id: 'accepted', selfResponseStatus: 'accepted' }),
];

describe('CalendarPane RSVP bar card restyle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 12));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('groups exactly the four named chips and keeps the text Today button outside the group', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: invitations })} />);

    const chips = ['Accepted', 'Maybe', 'Declined', 'Unaccepted (3)'].map((name) =>
      screen.getByRole('button', { name, exact: true }),
    );
    const groups = container.querySelectorAll('div.calendar-rsvp-chip-group');
    expect(groups).toHaveLength(1);
    expect(within(groups[0] as HTMLElement).getAllByRole('button')).toEqual(chips);
    for (const chip of chips) expect(chip.closest('.calendar-rsvp-chip-group')).toBe(groups[0]);

    const today = screen.getByRole('button', { name: 'Scroll to today', exact: true });
    expect(within(today).getByText('Today', { exact: true })).toBeVisible();
    expect(today).toHaveClass('calendar-today-btn');
    expect(today).not.toHaveClass('calendar-rsvp-chip');
    expect(today.closest('.calendar-rsvp-chip-group')).toBeNull();
    expect(today.parentElement).toBe(groups[0].parentElement);
    expect(today.querySelector('svg')).toBeNull();
  });

  it('scrolls the current event row today smoothly when Today is clicked', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    render(<CalendarPane {...baseProps({ events: [makeEvent({
      summary: 'Today current meeting',
      start: { dateTime: new Date(2026, 8, 27, 11, 30).toISOString() },
      end: { dateTime: new Date(2026, 8, 27, 12, 30).toISOString() },
    })] })} />);
    const row = screen.getByRole('link', { name: 'Today current meeting' }).closest('.calendar-event-row');
    expect(row).not.toBeNull();
    scroll.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(scroll.mock.instances[0]).toBe(row);
  });

  it('scrolls the today header smoothly when no timed event is available', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    render(<CalendarPane {...baseProps()} />);
    const header = screen.getByText('Today · Sep 27', { selector: '.calendar-day-header', exact: true });
    scroll.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(scroll.mock.instances[0]).toBe(header);
  });

  it('shows the literal badge count 3 even when needsAction events are filtered out', () => {
    render(<CalendarPane {...baseProps({ events: invitations, selectedRsvpStatuses: new Set(['accepted']) })} />);

    const chip = screen.getByRole('button', { name: 'Unaccepted (3)', exact: true });
    const badge = within(chip).getByText('3', { exact: true });
    expect(badge).toHaveClass('calendar-rsvp-chip-badge');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
  });

  it('omits the badge at zero while retaining the accessible count', () => {
    render(<CalendarPane {...baseProps({ events: [makeEvent({ selfResponseStatus: 'accepted' })] })} />);

    const chip = screen.getByRole('button', { name: 'Unaccepted (0)', exact: true });
    expect(chip.querySelector('.calendar-rsvp-chip-badge')).toBeNull();
    expect(within(chip).queryByText('0', { exact: true })).not.toBeInTheDocument();
  });

  it('uses the prototype 16px icons with 2.2 strokes and the circled clock for Unaccepted', () => {
    render(<CalendarPane {...baseProps()} />);

    for (const name of ['Accepted', 'Maybe', 'Declined', 'Unaccepted (0)']) {
      const svg = screen.getByRole('button', { name, exact: true }).querySelector('svg');
      expect(svg).toHaveAttribute('width', '16');
      expect(svg).toHaveAttribute('height', '16');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg?.querySelector('path')).toHaveAttribute('stroke-width', '2.2');
    }
    expect(screen.getByRole('button', { name: 'Unaccepted (0)' }).querySelector('path')).toHaveAttribute(
      'd', 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    );
  });

  describe.each([false, true])('T4 cards (all-day: %s)', (isAllDay) => {
    it.each(['accepted', 'tentative', 'declined', 'needsAction'] as const)(
      'renders exactly one accessible %s square last in the top-right header', (status) => {
        const { container } = render(<CalendarPane {...baseProps({
          events: [makeEvent({
            selfResponseStatus: status, isAllDay,
            ...(isAllDay ? { start: { date: '2026-09-27' }, end: { date: '2026-09-28' } } : {}),
          })],
          selectedRsvpStatuses: new Set([status]),
        })} />);
        const card = container.querySelector(isAllDay ? '.calendar-event-allday' : '.calendar-event-row') as HTMLElement;
        const images = within(card).getAllByRole('img');
        expect(images).toHaveLength(1);
        const icon = within(card).getByRole('img', { name: status, exact: true });
        expect(icon).toHaveAttribute('aria-label', status);
        expect(icon).toHaveAttribute('title', status);
        expect(icon).toHaveClass('calendar-event-rsvp', `calendar-event-rsvp--${status}`);
        const header = card.querySelector('.calendar-event-header');
        expect(header).toBe(card.firstElementChild);
        const actions = isAllDay ? header : header?.querySelector('.calendar-event-actions');
        expect(icon.parentElement).toBe(actions);
        expect(actions?.lastElementChild).toBe(icon);
        if (!isAllDay) {
          expect(header?.lastElementChild).toBe(actions);
          expect(actions?.previousElementSibling).toHaveClass('calendar-event-time');
          expect(actions?.querySelector('a')).toBeNull();
        }
        expect(icon.querySelector('svg')).toHaveAttribute('width', '14');
        expect(icon.querySelector('svg')).toHaveAttribute('height', '14');
        expect(icon.querySelector('path')).toHaveAttribute('stroke-width', '2.4');
        const chipName = { accepted: 'Accepted', tentative: 'Maybe', declined: 'Declined', needsAction: 'Unaccepted (1)' }[status];
        expect(icon.querySelector('path')?.getAttribute('d')).toBe(
          screen.getByRole('button', { name: chipName, exact: true }).querySelector('path')?.getAttribute('d'),
        );
      },
    );

    it.each([undefined, 'unknown'])('uses needsAction for invalid status %s', (status) => {
      const selfResponseStatus = status as CalendarEvent['selfResponseStatus'];
      const { container } = render(<CalendarPane {...baseProps({
        events: [makeEvent({
          selfResponseStatus, isAllDay,
          ...(isAllDay ? { start: { date: '2026-09-27' }, end: { date: '2026-09-28' } } : {}),
        })],
        selectedRsvpStatuses: new Set([selfResponseStatus]),
      })} />);
      const card = container.querySelector(isAllDay ? '.calendar-event-allday' : '.calendar-event-row') as HTMLElement;
      expect(within(card).getAllByRole('img')).toHaveLength(1);
      expect(within(card).getByRole('img', { name: 'needsAction', exact: true })).toHaveAttribute('title', 'needsAction');
    });

    it('preserves title, host action, calendar label and organizer order', () => {
      const action = vi.fn();
      const bubbled = vi.fn();
      const joinUrl = 'https://meet.google.com/t4';
      const { container } = render(<div onClick={bubbled}><CalendarPane {...baseProps({
        events: [makeEvent({
          summary: 'T4 meeting', calendarId: 'team', joinUrl, isAllDay,
          organizer: { self: false, displayName: 'Organizer' },
          ...(isAllDay ? { start: { date: '2026-09-27' }, end: { date: '2026-09-28' } } : {}),
        })],
        calendars: [{ id: 'team', summary: 'Team calendar', primary: false, backgroundColor: '#123456' }],
      })} renderEventAction={() => <button onClick={action}>Host action</button>} /></div>);
      const card = container.querySelector(isAllDay ? '.calendar-event-allday' : '.calendar-event-row') as HTMLElement;
      const title = within(card).getByText('T4 meeting');
      const hostAction = within(card).getByRole('button', { name: 'Host action' });
      const calendar = within(card).getByText('Team calendar');
      const organizer = within(card).getByText('Organizer');
      for (const [before, after] of [[title, hostAction], [hostAction, calendar], [calendar, organizer]]) {
        expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(hostAction.parentElement).toBe(title.closest('.calendar-event-title-wrap'));
      fireEvent.click(hostAction);
      expect(action).toHaveBeenCalledTimes(1);
      if (!isAllDay) {
        const join = within(card).getByRole('link', { name: 'Join', exact: true });
        expect(join).toHaveAttribute('href', joinUrl);
        expect(join).toHaveAttribute('target', '_blank');
        expect(join).toHaveAttribute('rel', 'noopener noreferrer');
        expect(join.parentElement).toHaveClass('calendar-event-actions');
        expect(join.parentElement?.previousElementSibling).toHaveClass('calendar-event-time');
        expect(join.parentElement?.firstElementChild).toBe(join);
        expect(join.nextElementSibling).toBe(within(card).getByRole('img'));
        expect(join.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        bubbled.mockClear();
        const open = vi.spyOn(window, 'open');
        expect(fireEvent.click(join)).toBe(true);
        expect(bubbled).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      }
    });
  });

  it('independently toggles every pressed chip and preserves host membership on remount', () => {
    const props = baseProps({ events: invitations });
    let saved: RsvpSelection = new Set(['accepted', 'tentative']);
    const onChange = vi.fn((next: RsvpSelection) => { saved = new Set(next); });
    function Host() {
      const [selection, setSelection] = useState(saved);
      return <CalendarPane {...props} selectedRsvpStatuses={selection} onRsvpStatusesChange={(next) => {
        onChange(next);
        setSelection(next);
      }} />;
    }
    const expectPressed = (accepted: boolean, maybe: boolean, declined: boolean, unaccepted: boolean) => {
      for (const [name, pressed] of [
        ['Accepted', accepted], ['Maybe', maybe], ['Declined', declined], ['Unaccepted (3)', unaccepted],
      ] as const) expect(screen.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', String(pressed));
    };
    const view = render(<Host />);
    expectPressed(true, true, false, false);

    fireEvent.click(screen.getByRole('button', { name: 'Declined' }));
    expectPressed(true, true, true, false);
    fireEvent.click(screen.getByRole('button', { name: 'Maybe' }));
    expectPressed(true, false, true, false);
    fireEvent.click(screen.getByRole('button', { name: 'Accepted' }));
    expectPressed(false, false, true, false);
    fireEvent.click(screen.getByRole('button', { name: 'Accepted' }));
    expectPressed(true, false, true, false);

    fireEvent.click(screen.getByRole('button', { name: 'Unaccepted (3)' }));
    expectPressed(true, false, true, true);
    expect(onChange).toHaveBeenLastCalledWith(new Set(['accepted', 'declined', 'needsAction']));
    fireEvent.click(screen.getByRole('button', { name: 'Unaccepted (3)' }));
    expectPressed(true, false, true, false);
    expect(onChange).toHaveBeenLastCalledWith(new Set(['accepted', 'declined']));
    expect(saved).toEqual(new Set(['accepted', 'declined']));
    fireEvent.click(screen.getByRole('button', { name: 'Unaccepted (3)' }));
    expectPressed(true, false, true, true);
    expect(saved).toEqual(new Set(['accepted', 'declined', 'needsAction']));

    view.unmount();
    render(<Host />);
    expectPressed(true, false, true, true);
    fireEvent.click(screen.getByRole('button', { name: 'Unaccepted (3)' }));
    expectPressed(true, false, true, false);
    expect(onChange).toHaveBeenLastCalledWith(new Set(['accepted', 'declined']));
  });
});
