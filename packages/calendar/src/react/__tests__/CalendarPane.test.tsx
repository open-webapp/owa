import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { within } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { DEFAULT_RSVP_STATUSES } from '../../core/events.js';
import type { CalendarEvent, CalendarInfo } from '../../core/types.js';
import { makeEvent, baseProps, type PaneTestOverrides, type RsvpSelection } from './helpers.js';

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
  window.dispatchEvent(new Event('resize'));
}

function setWin(o: Record<string, number>) {
  for (const [k, v] of Object.entries(o)) {
    Object.defineProperty(window, k, { configurable: true, writable: true, value: v });
  }
}

const POPUP_NAME = 'notesdiary-cal-event';

describe('CalendarPane', () => {
  beforeEach(() => {
    vi.stubGlobal('open', vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Unaccepted chip', () => {
    function needsActionEvents(count: number) {
      return Array.from({ length: count }, (_, index) => makeEvent({
        id: `needs-action-${index}`,
        selfResponseStatus: 'needsAction',
      }));
    }

    it('renders chips in DOM order Accepted, Maybe, Declined, Unaccepted last', () => {
      render(<CalendarPane {...baseProps()} />);

      const chips = screen.getAllByRole('button', { name: /^(Accepted|Maybe|Declined|Unaccepted)(\s*\(\d+\))?$/ });
      expect(chips).toEqual([
        screen.getByRole('button', { name: 'Accepted' }),
        screen.getByRole('button', { name: 'Maybe' }),
        screen.getByRole('button', { name: 'Declined' }),
        screen.getByRole('button', { name: /^Unaccepted/ }),
      ]);
    });

    it('names the button Unaccepted (3) for three needsAction events', () => {
      render(<CalendarPane {...baseProps({ events: needsActionEvents(3) })} />);

      expect(screen.getByRole('button', { name: 'Unaccepted (3)' })).toBeInTheDocument();
    });

    it('still renders Unaccepted (0) when no events need action', () => {
      render(<CalendarPane {...baseProps({ events: [makeEvent({ selfResponseStatus: 'accepted' })] })} />);

      expect(screen.getByRole('button', { name: 'Unaccepted (0)' })).toBeInTheDocument();
    });

    it.each([
      [100, '99+', 'Unaccepted (100)'],
      [99, '99', 'Unaccepted (99)'],
    ])('shows the badge for %i needsAction events with the full accessible count', (count, badge, name) => {
      render(<CalendarPane {...baseProps({ events: needsActionEvents(count) })} />);

      const chip = screen.getByRole('button', { name });
      expect(within(chip).getByText(badge, { exact: true })).toBeVisible();
    });

    it('counts three needsAction events even when only Accepted is selected', () => {
      render(<CalendarPane {...baseProps({
        events: needsActionEvents(3),
        selectedRsvpStatuses: new Set(['accepted']),
      })} />);

      expect(screen.getByRole('button', { name: 'Unaccepted (3)' })).toBeInTheDocument();
    });

    it('counts only the two needsAction events among accepted and declined events', () => {
      render(<CalendarPane {...baseProps({ events: [
        ...needsActionEvents(2),
        makeEvent({ id: 'accepted', selfResponseStatus: 'accepted' }),
        makeEvent({ id: 'declined', selfResponseStatus: 'declined' }),
      ] })} />);

      expect(screen.getByRole('button', { name: 'Unaccepted (2)' })).toBeInTheDocument();
    });

    it('does not count a needsAction event after its calendar is deselected', () => {
      const events = [
        makeEvent({ id: 'personal', summary: 'Personal invitation', calendarId: 'primary', selfResponseStatus: 'needsAction' }),
        makeEvent({ id: 'team', summary: 'Team invitation', calendarId: 'team', selfResponseStatus: 'needsAction' }),
      ];
      const props = baseProps({
        calendars: [
          { id: 'primary', summary: 'Primary', primary: true },
          { id: 'team', summary: 'Team', primary: false },
        ],
        selectedCalendarIds: ['primary', 'team'],
      });
      // Host fixture: unlike the shared fake, expose only selected-calendar events.
      props.controller.getEvents = () => events.filter((event) =>
        props.controller.getSelectedIds(event.sourceId).includes(event.calendarId!),
      );
      render(<CalendarPane {...props} />);
      expect(screen.getByRole('link', { name: 'Team invitation' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByRole('option', { name: 'Team' }));

      expect(screen.queryByRole('link', { name: 'Team invitation' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Personal invitation' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Unaccepted (1)' })).toBeInTheDocument();
    });

    it.each([
      ['empty', []],
      ['undefined-equivalent', undefined],
    ] as const)('renders Unaccepted (0) without throwing for %s events', (_label, events) => {
      // Omitted/undefined host events normalize to [] in the controller fixture.
      expect(() => render(<CalendarPane {...baseProps({ events: events ? [...events] : undefined })} />)).not.toThrow();

      expect(screen.getByRole('button', { name: 'Unaccepted (0)' })).toBeInTheDocument();
    });

    function renderControlledSelection(initial: RsvpSelection) {
      const props = baseProps({ events: [
        makeEvent({ id: 'accepted', summary: 'Accepted invitation', selfResponseStatus: 'accepted' }),
        makeEvent({ id: 'tentative', summary: 'Maybe invitation', selfResponseStatus: 'tentative' }),
        makeEvent({ id: 'declined', summary: 'Declined invitation', selfResponseStatus: 'declined' }),
        makeEvent({ id: 'pending', summary: 'Pending invitation', selfResponseStatus: 'needsAction' }),
      ] });
      const onRsvpStatusesChange = vi.fn();
      let changeFromHost!: (next: RsvpSelection) => void;

      function ControlledHost() {
        const [selection, setSelection] = useState(initial);
        changeFromHost = setSelection;
        return <CalendarPane
          {...props}
          selectedRsvpStatuses={selection}
          onRsvpStatusesChange={(next) => {
            onRsvpStatusesChange(next);
            setSelection(next);
          }}
        />;
      }

      render(<ControlledHost />);
      return {
        onRsvpStatusesChange,
        changeFromHost: (next: RsvpSelection) => act(() => changeFromHost(next)),
      };
    }

    function expectPressedSelection(selection: RsvpSelection) {
      for (const [status, name] of [
        ['accepted', /^Accepted$/],
        ['tentative', /^Maybe$/],
        ['declined', /^Declined$/],
      ] as const) {
        expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', String(selection.has(status)));
      }
      expect(screen.getByRole('button', { name: /^Unaccepted/ })).toHaveAttribute(
        'aria-pressed', String(selection.has('needsAction')),
      );
    }

    function expectVisibleInvitations(names: string[]) {
      for (const name of ['Accepted', 'Maybe', 'Declined', 'Pending']) {
        expect(screen.queryByRole('link', { name: `${name} invitation` }) !== null).toBe(names.includes(name));
      }
    }

    it('defaults show pending with O pressed', () => {
      const { onRsvpStatusesChange } = renderControlledSelection(new Set(DEFAULT_RSVP_STATUSES));
      expectVisibleInvitations(['Accepted', 'Maybe', 'Pending']);
      expectPressedSelection(new Set(DEFAULT_RSVP_STATUSES));
      expect(onRsvpStatusesChange).not.toHaveBeenCalled();
    });

    it('default O click hides only pending and the next click restores it', () => {
      const original = new Set(DEFAULT_RSVP_STATUSES);
      const { onRsvpStatusesChange } = renderControlledSelection(original);
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenNthCalledWith(1, new Set(['accepted', 'tentative']));
      expectVisibleInvitations(['Accepted', 'Maybe']);
      expectPressedSelection(new Set(['accepted', 'tentative']));
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenNthCalledWith(2, original);
      expectVisibleInvitations(['Accepted', 'Maybe', 'Pending']);
      expectPressedSelection(original);
      expect(original).toEqual(new Set(['accepted', 'tentative', 'needsAction']));
      expect(onRsvpStatusesChange).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['accepted', 'Accepted'], ['tentative', 'Maybe'], ['declined', 'Declined'],
    ] as const)('removing %s from mixed membership keeps only pending', (status, name) => {
      const original: RsvpSelection = new Set([status, 'needsAction']);
      const { onRsvpStatusesChange } = renderControlledSelection(original);
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onRsvpStatusesChange).toHaveBeenCalledTimes(1);
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['needsAction']));
      expectVisibleInvitations(['Pending']);
      expectPressedSelection(new Set(['needsAction']));
      expect(original).toEqual(new Set([status, 'needsAction']));
    });

    it.each([
      ['accepted', 'Accepted'], ['tentative', 'Maybe'], ['declined', 'Declined'], ['needsAction', 'Pending'],
    ] as const)('singleton %s displays only its own invitation', (status, name) => {
      const { onRsvpStatusesChange } = renderControlledSelection(new Set([status]));
      expectVisibleInvitations([name]);
      expectPressedSelection(new Set([status]));
      expect(onRsvpStatusesChange).not.toHaveBeenCalled();
    });

    it('host rerenders mixed, pending-only and empty selections without callbacks or mutation', () => {
      const { onRsvpStatusesChange, changeFromHost } = renderControlledSelection(new Set(['accepted']));
      const mixed: RsvpSelection = new Set(['tentative', 'needsAction']);
      const pending: RsvpSelection = new Set(['needsAction']);
      const empty: RsvpSelection = new Set();
      for (const [selection, visible] of [
        [mixed, ['Maybe', 'Pending']], [pending, ['Pending']], [empty, []],
      ] as const) {
        changeFromHost(selection);
        expectVisibleInvitations([...visible]);
        expect(onRsvpStatusesChange).not.toHaveBeenCalled();
        expectPressedSelection(selection);
      }
      expect(mixed).toEqual(new Set(['tentative', 'needsAction']));
      expect(pending).toEqual(new Set(['needsAction']));
      expect(empty.size).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenCalledTimes(1);
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['needsAction']));
      expectVisibleInvitations(['Pending']);
      expect(empty.size).toBe(0);
    });

    it('adds needsAction without removing accepted or maybe in a controlled host', () => {
      const { onRsvpStatusesChange } = renderControlledSelection(new Set(['accepted', 'tentative']));

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));

      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['accepted', 'tentative', 'needsAction']));
      expectPressedSelection(new Set(DEFAULT_RSVP_STATUSES));
    });

    it('returns to the original membership on a second Unaccepted click without mutating it', () => {
      const original: RsvpSelection = new Set(['accepted', 'tentative']);
      const { onRsvpStatusesChange } = renderControlledSelection(original);

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));

      expect(onRsvpStatusesChange).toHaveBeenNthCalledWith(1, new Set(['accepted', 'tentative', 'needsAction']));
      expect(onRsvpStatusesChange).toHaveBeenNthCalledWith(2, original);
      expectPressedSelection(original);
      expect(original).toEqual(new Set(['accepted', 'tentative']));
      expect(onRsvpStatusesChange).toHaveBeenCalledTimes(2);
    });

    it('toggles Accepted against current membership while keeping pending selected', () => {
      const { onRsvpStatusesChange } = renderControlledSelection(new Set(['accepted', 'tentative']));

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Accepted' }));

      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['tentative', 'needsAction']));
      expectPressedSelection(new Set(['tentative', 'needsAction']));

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['tentative']));
      expectPressedSelection(new Set(['tentative']));
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['tentative', 'needsAction']));
      expectPressedSelection(new Set(['tentative', 'needsAction']));
    });

    it.each([
      ['accepted', 'Accepted'], ['tentative', 'Maybe'], ['declined', 'Declined'],
    ] as const)('uses defaults when toggling the sole %s selection', (status, name) => {
      const { onRsvpStatusesChange } = renderControlledSelection(new Set([status]));

      fireEvent.click(screen.getByRole('button', { name }));

      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(DEFAULT_RSVP_STATUSES));
      expectPressedSelection(new Set(DEFAULT_RSVP_STATUSES));
    });

    it('uses the fresh host selection after an external change', () => {
      const { onRsvpStatusesChange, changeFromHost } = renderControlledSelection(new Set(['accepted', 'tentative']));

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      changeFromHost(new Set(['accepted']));
      expectPressedSelection(new Set(['accepted']));

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['accepted', 'needsAction']));
      expectPressedSelection(new Set(['accepted', 'needsAction']));
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['accepted']));
      expectPressedSelection(new Set(['accepted']));
    });

    it('uses defaults when toggling the sole needsAction selection', () => {
      const { onRsvpStatusesChange } = renderControlledSelection(new Set(['needsAction']));
      expectPressedSelection(new Set(['needsAction']));

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));

      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(DEFAULT_RSVP_STATUSES));
      expectPressedSelection(new Set(DEFAULT_RSVP_STATUSES));
    });

    it.each(['accepted', 'tentative', 'declined'] as const)('removes only pending from mixed %s membership and restores it', (status) => {
      const original: RsvpSelection = new Set(['needsAction', status]);
      const { onRsvpStatusesChange } = renderControlledSelection(original);
      expectPressedSelection(original);

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set([status]));
      expectPressedSelection(new Set([status]));
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(original);
      expectPressedSelection(original);
      expect(original).toEqual(new Set(['needsAction', status]));
    });

    it('keeps the ordinary Accepted toggle and later restores that resulting selection', () => {
      const { onRsvpStatusesChange } = renderControlledSelection(new Set(['accepted', 'tentative']));

      fireEvent.click(screen.getByRole('button', { name: 'Accepted' }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['tentative']));
      expectPressedSelection(new Set(['tentative']));

      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Unaccepted/ }));
      expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['tentative']));
      expectPressedSelection(new Set(['tentative']));
    });

    it('restores the original observable selection after a quick double click', async () => {
      vi.useRealTimers();
      const original: RsvpSelection = new Set(['accepted', 'tentative']);
      const { onRsvpStatusesChange } = renderControlledSelection(original);
      const user = userEvent.setup();

      await user.dblClick(screen.getByRole('button', { name: /^Unaccepted/ }));

      expect(onRsvpStatusesChange).toHaveBeenNthCalledWith(2, original);
      expectPressedSelection(original);
    });
  });

  it('shows connect prompt when not connected, and calls onConnect', () => {
    const onConnect = vi.fn();
    render(<CalendarPane {...baseProps({ connected: false, onConnect })} />);
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/calendar-day-header/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /connect google calendar/i }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('shows reconnect prompt when needsReauth, and calls onReconnect', () => {
    const onReconnect = vi.fn();
    render(<CalendarPane {...baseProps({ needsReauth: true, onReconnect })} />);
    expect(screen.getByText(/reauthorization/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('renders the calendar selector in the pane footer and forwards selection changes', () => {
    const onCalendarSelectionChange = vi.fn();
    const calendars: CalendarInfo[] = [
      { id: 'primary', summary: 'Primary', primary: true },
      { id: 'team', summary: 'Team', primary: false },
    ];
    render(
      <CalendarPane
        {...baseProps({ calendars, selectedCalendarIds: ['primary', 'team'], onCalendarSelectionChange })}
      />
    );

    expect(document.querySelector('.calendar-pane-footer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Team' }));

    expect(onCalendarSelectionChange).toHaveBeenCalledWith(['primary']);
  });

  it('hides the calendar selector footer while disconnected or when no calendars are available', () => {
    const calendars: CalendarInfo[] = [{ id: 'primary', summary: 'Primary', primary: true }];
    const { rerender } = render(<CalendarPane {...baseProps({ connected: false, calendars })} />);
    expect(document.querySelector('.calendar-pane-footer')).toBeNull();

    rerender(<CalendarPane {...baseProps({ calendars: [], selectedCalendarIds: [] })} />);
    expect(document.querySelector('.calendar-pane-footer')).toBeNull();
  });

  it('renders the calendar selector footer in the mobile pane', () => {
    setWidth(500);
    const calendars: CalendarInfo[] = [{ id: 'primary', summary: 'Primary', primary: true }];
    render(
      <CalendarPane
        {...baseProps({ calendars, selectedCalendarIds: ['primary'], onCalendarSelectionChange: vi.fn() })}
      />
    );

    expect(document.querySelector('.calendar-pane-footer')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('shows a colored calendar dot and name for non-primary events, but not primary events', () => {
    const calendars: CalendarInfo[] = [
      { id: 'primary', summary: 'Personal', primary: true, backgroundColor: '#123456' },
      { id: 'team', summary: 'Engineering', primary: false, backgroundColor: '#abcdef' },
    ];
    const events = [
      makeEvent({ id: 'primary-event', summary: 'Personal Event', calendarId: 'primary' }),
      makeEvent({ id: 'team-event', summary: 'Team Event', calendarId: 'team' }),
    ];

    render(<CalendarPane {...baseProps({ events, calendars })} />);

    const teamRow = screen.getByText('Team Event').closest('.calendar-event-row')!;
    expect(teamRow).toHaveTextContent('Engineering');
    expect(teamRow.querySelector('.calendar-event-calendar-dot')).toHaveStyle({ backgroundColor: '#abcdef' });
    expect(screen.getByText('Personal Event').closest('.calendar-event-row')?.querySelector('.calendar-event-calendar')).toBeNull();
  });

  it('does not repeat a shared calendar name as its organizer', () => {
    const calendars: CalendarInfo[] = [
      { id: 'release', summary: 'Release Calendar', primary: false, backgroundColor: '#abcdef' },
    ];
    const event = makeEvent({
      calendarId: 'release',
      organizer: { displayName: 'Release Calendar', self: false },
    });

    render(<CalendarPane {...baseProps({ events: [event], calendars })} />);

    expect(screen.getAllByText('Release Calendar')).toHaveLength(1);
  });

  it('uses composite calendar-event keys so duplicate event IDs render and open their own popup', () => {
    act(() => setWidth(1200));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events = [
      makeEvent({
        id: 'shared-id',
        calendarId: 'primary',
        summary: 'Primary Copy',
        htmlLink: 'https://cal.test/primary',
        start: { dateTime: '2026-09-27T10:00:00Z' },
        end: { dateTime: '2026-09-27T11:00:00Z' },
      }),
      makeEvent({
        id: 'shared-id',
        calendarId: 'team',
        summary: 'Team Copy',
        htmlLink: 'https://cal.test/team',
        start: { dateTime: '2026-09-27T14:00:00Z' },
        end: { dateTime: '2026-09-27T15:00:00Z' },
      }),
    ];

    try {
      render(<CalendarPane {...baseProps({ events })} />);

      expect(screen.getByText('Primary Copy')).toBeInTheDocument();
      expect(screen.getByText('Team Copy')).toBeInTheDocument();
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('unique "key"');
      expect(screen.getByText('Primary Copy').closest('.calendar-event-row')).not.toHaveClass('calendar-event-row--selected');
      expect(screen.getByText('Team Copy').closest('.calendar-event-row')).toHaveClass('calendar-event-row--selected');

      fireEvent.click(screen.getByRole('link', { name: 'Team Copy' }));
      expect(window.open).toHaveBeenCalledWith('https://cal.test/team', 'notesdiary-cal-event', expect.any(String));
    } finally {
      consoleError.mockRestore();
      act(() => setWidth(1024));
    }
  });

  it('applies the RSVP filter to non-primary calendar events', () => {
    const event = makeEvent({
      id: 'team-declined',
      calendarId: 'team',
      summary: 'Declined Team Event',
      selfResponseStatus: 'declined',
    });

    render(<CalendarPane {...baseProps({ events: [event], selectedRsvpStatuses: new Set(['accepted']) })} />);

    expect(screen.queryByText('Declined Team Event')).not.toBeInTheDocument();
  });

  it('shows empty state plus a zero-event Today header when connected and no events', () => {
    render(<CalendarPane {...baseProps({ events: [] })} />);
    expect(screen.getByText(/no matching events in the next 30 days/i)).toBeInTheDocument();
    expect(document.querySelectorAll('.calendar-day-header').length).toBe(1);
    expect(document.querySelectorAll('.calendar-event-row').length).toBe(0);
    expect(document.querySelectorAll('.calendar-event-allday').length).toBe(0);
  });

  it('shows a distinct error state (not the empty state) when a fetch failed and no events are cached', () => {
    render(<CalendarPane {...baseProps({ events: [], error: true })} />);
    expect(screen.queryByText(/no events in the next 30 days/i)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load calendar events/i);
  });

  it('prefers stale cached events over the error state when a later fetch failed', () => {
    render(<CalendarPane {...baseProps({ events: [makeEvent({})], error: true })} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Event')).toBeInTheDocument();
  });

  it('groups events by day, renders all-day distinctly, and excludes declined when Declined is not selected', () => {
    const events: CalendarEvent[] = [
      makeEvent({
        id: 'timed-day1',
        summary: 'Timed Day 1',
        start: { dateTime: '2026-09-27T10:00:00Z' },
        end: { dateTime: '2026-09-27T11:00:00Z' },
      }),
      makeEvent({
        id: 'allday-day1',
        summary: 'All Day Event',
        start: { date: '2026-09-27' },
        end: { date: '2026-09-28' },
        isAllDay: true,
      }),
      makeEvent({
        id: 'declined-day1',
        summary: 'Declined Event',
        start: { dateTime: '2026-09-27T12:00:00Z' },
        end: { dateTime: '2026-09-27T13:00:00Z' },
        selfResponseStatus: 'declined',
      }),
      makeEvent({
        id: 'timed-day2',
        summary: 'Timed Day 2',
        start: { dateTime: '2026-09-28T09:00:00Z' },
        end: { dateTime: '2026-09-28T10:00:00Z' },
      }),
    ];

    render(<CalendarPane {...baseProps({ events })} />);

    const headers = document.querySelectorAll('.calendar-day-header');
    expect(headers.length).toBe(2);

    expect(screen.getByText('All Day Event')).toBeInTheDocument();
    expect(screen.getByText('All Day Event').closest('.calendar-event-allday')).not.toBeNull();

    expect(screen.getByText('Timed Day 1').closest('.calendar-event-row')).not.toBeNull();

    expect(screen.queryByText('Declined Event')).not.toBeInTheDocument();
  });

  it('includes a declined event when Declined is selected', () => {
    const events: CalendarEvent[] = [
      makeEvent({
        id: 'timed-day1',
        summary: 'Timed Day 1',
        start: { dateTime: '2026-09-27T10:00:00Z' },
        end: { dateTime: '2026-09-27T11:00:00Z' },
      }),
      makeEvent({
        id: 'allday-day1',
        summary: 'All Day Event',
        start: { date: '2026-09-27' },
        end: { date: '2026-09-28' },
        isAllDay: true,
      }),
      makeEvent({
        id: 'declined-day1',
        summary: 'Declined Event',
        start: { dateTime: '2026-09-27T12:00:00Z' },
        end: { dateTime: '2026-09-27T13:00:00Z' },
        selfResponseStatus: 'declined',
      }),
      makeEvent({
        id: 'timed-day2',
        summary: 'Timed Day 2',
        start: { dateTime: '2026-09-28T09:00:00Z' },
        end: { dateTime: '2026-09-28T10:00:00Z' },
      }),
    ];

    render(
      <CalendarPane
        {...baseProps({
          events,
          selectedRsvpStatuses: new Set(['accepted', 'tentative', 'needsAction', 'declined']) as RsvpSelection,
        })}
      />
    );

    expect(screen.getByText('Declined Event')).toBeInTheDocument();
  });

  it.each([
    ['accepted', 'calendar-event-row--rsvp-accepted'],
    ['tentative', 'calendar-event-row--rsvp-tentative'],
    ['needsAction', 'calendar-event-row--rsvp-needsAction'],
    ['declined', 'calendar-event-row--rsvp-declined'],
  ])('adds %s RSVP class to a timed event row', (selfResponseStatus, rsvpClass) => {
    const event = makeEvent({
      id: `timed-${selfResponseStatus}`,
      summary: `Timed ${selfResponseStatus}`,
      selfResponseStatus: selfResponseStatus as CalendarEvent['selfResponseStatus'],
    });

    render(
      <CalendarPane
        {...baseProps({
          events: [event],
          selectedRsvpStatuses: new Set(['accepted', 'tentative', 'needsAction', 'declined']) as RsvpSelection,
        })}
      />
    );

    expect(screen.getByText(`Timed ${selfResponseStatus}`).closest('.calendar-event-row')).toHaveClass(rsvpClass);
  });

  it.each([
    ['accepted', 'calendar-event-row--rsvp-accepted'],
    ['tentative', 'calendar-event-row--rsvp-tentative'],
    ['needsAction', 'calendar-event-row--rsvp-needsAction'],
    ['declined', 'calendar-event-row--rsvp-declined'],
  ])('adds %s RSVP class to an all-day event banner', (selfResponseStatus, rsvpClass) => {
    const event = makeEvent({
      id: `allday-${selfResponseStatus}`,
      summary: `All-day ${selfResponseStatus}`,
      start: { date: '2026-09-27' },
      end: { date: '2026-09-28' },
      isAllDay: true,
      selfResponseStatus: selfResponseStatus as CalendarEvent['selfResponseStatus'],
    });

    render(
      <CalendarPane
        {...baseProps({
          events: [event],
          selectedRsvpStatuses: new Set(['accepted', 'tentative', 'needsAction', 'declined']) as RsvpSelection,
        })}
      />
    );

    expect(screen.getByText(`All-day ${selfResponseStatus}`).closest('.calendar-event-allday')).toHaveClass(rsvpClass);
  });

  it('keeps the RSVP class when a timed row is selected by clicking it', () => {
    const event = makeEvent({
      id: 'selected-row',
      summary: 'Selected Row',
      start: { dateTime: '2026-09-27T14:00:00Z' },
      end: { dateTime: '2026-09-27T15:00:00Z' },
      selfResponseStatus: 'tentative',
    });
    render(<CalendarPane {...baseProps({ events: [event] })} />);

    const row = screen.getByText('Selected Row').closest('.calendar-event-row')!;
    fireEvent.click(row);

    expect(row).toHaveClass('calendar-event-row--selected');
    expect(row).toHaveClass('calendar-event-row--rsvp-tentative');
  });

  it('keeps the RSVP class when a timed row is current', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const event = makeEvent({
      id: 'current-rsvp',
      summary: 'Current RSVP',
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
      selfResponseStatus: 'accepted',
    });
    render(<CalendarPane {...baseProps({ events: [event] })} />);

    const row = screen.getByText('Current RSVP').closest('.calendar-event-row')!;
    expect(row).toHaveClass('calendar-event-row--current');
    expect(row).toHaveClass('calendar-event-row--rsvp-accepted');
  });

  it('adds exactly the event RSVP class to a row', () => {
    const event = makeEvent({ id: 'only-tentative', summary: 'Only Tentative', selfResponseStatus: 'tentative' });
    render(<CalendarPane {...baseProps({ events: [event] })} />);

    const row = screen.getByText('Only Tentative').closest('.calendar-event-row')!;
    expect(Array.from(row.classList).filter((className) => className.startsWith('calendar-event-row--rsvp-'))).toEqual([
      'calendar-event-row--rsvp-tentative',
    ]);
  });

  it.each([
    [undefined, 'missing'],
    ['unknown', 'unknown'],
    ['garbage', 'garbage'],
  ])('defaults a %s RSVP status to needsAction without throwing', (selfResponseStatus, label) => {
    const event = makeEvent({
      id: `default-${label}`,
      summary: `Default ${label}`,
      selfResponseStatus: selfResponseStatus as CalendarEvent['selfResponseStatus'],
    });

    expect(() => render(
      <CalendarPane
        {...baseProps({
          events: [event],
          selectedRsvpStatuses: new Set([selfResponseStatus]) as RsvpSelection,
        })}
      />
    )).not.toThrow();
    expect(screen.getByText(`Default ${label}`).closest('.calendar-event-row')).toHaveClass(
      'calendar-event-row--rsvp-needsAction'
    );
  });

  it('renders active chip via aria-pressed based on selectedRsvpStatuses prop, and clicking a chip calls onRsvpStatusesChange', () => {
    const onRsvpStatusesChange = vi.fn();
    const events = [makeEvent({ id: 'e1', summary: 'Some Event' })];
    render(
      <CalendarPane {...baseProps({ events, onRsvpStatusesChange })} />
    );

    const acceptedButton = screen.getByRole('button', { name: 'Accepted' });
    expect(acceptedButton).toHaveAttribute('aria-pressed', 'true');

    const declinedButton = screen.getByRole('button', { name: 'Declined' });
    expect(declinedButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(declinedButton);
    expect(onRsvpStatusesChange).toHaveBeenCalledWith(
      new Set(['accepted', 'tentative', 'needsAction', 'declined'])
    );
  });

  it('clicking the last selected button snaps back to the default selection instead of leaving zero selected', () => {
    const onRsvpStatusesChange = vi.fn();
    const events = [makeEvent({ id: 'e1', summary: 'Some Event' })];
    render(
      <CalendarPane
        {...baseProps({
          events,
          selectedRsvpStatuses: new Set(['accepted']) as RsvpSelection,
          onRsvpStatusesChange,
        })}
      />
    );

    const acceptedButton = screen.getByRole('button', { name: 'Accepted' });
    fireEvent.click(acceptedButton);

    expect(onRsvpStatusesChange).toHaveBeenCalledWith(new Set(DEFAULT_RSVP_STATUSES));
  });

  it('changing the selectedRsvpStatuses prop changes what is displayed', () => {
    const events = [
      makeEvent({ id: 'accepted-1', summary: 'Accepted Event', selfResponseStatus: 'accepted' }),
      makeEvent({ id: 'tentative-1', summary: 'Tentative Event', selfResponseStatus: 'tentative' }),
    ];
    const { rerender } = render(<CalendarPane {...baseProps({ events })} />);
    expect(screen.getByText('Accepted Event')).toBeInTheDocument();
    expect(screen.getByText('Tentative Event')).toBeInTheDocument();

    rerender(
      <CalendarPane
        {...baseProps({ events, selectedRsvpStatuses: new Set(['accepted']) as RsvpSelection })}
      />
    );
    expect(screen.getByText('Accepted Event')).toBeInTheDocument();
    expect(screen.queryByText('Tentative Event')).not.toBeInTheDocument();
  });

  it('clicking the title opens htmlLink; clicking Join opens joinUrl and does not also open htmlLink; clicking elsewhere on the row does nothing', () => {
    const event = makeEvent({
      id: 'join-evt',
      summary: 'Meeting With Join',
      htmlLink: 'https://calendar.google.com/event?eid=join-evt',
      joinUrl: 'https://meet.example.com/abc',
    });
    render(<CalendarPane {...baseProps({ events: [event] })} />);

    const joinLink = screen.getByRole('link', { name: /^join$/i });
    expect(joinLink).toHaveAttribute('href', 'https://meet.example.com/abc');
    expect(joinLink).toHaveAttribute('target', '_blank');
    fireEvent.click(joinLink);
    expect(window.open).not.toHaveBeenCalled();

    const row = screen.getByText('Meeting With Join').closest('.calendar-event-row')!;
    fireEvent.click(row);
    expect(window.open).not.toHaveBeenCalled();

    const titleLink = screen.getByRole('link', { name: /meeting with join/i });
    expect(titleLink).toHaveAttribute('href', 'https://calendar.google.com/event?eid=join-evt');
    expect(titleLink).toHaveAttribute('target', '_blank');
    expect(titleLink).toHaveAttribute('rel', 'noopener noreferrer');
    act(() => setWidth(500));
    fireEvent.click(titleLink);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('renders organizer fallback: displayName wins, then email, then You for self with no name/email', () => {
    const events = [
      makeEvent({
        id: 'org-displayname',
        summary: 'Has Display Name',
        organizer: { displayName: 'Alice Example', email: 'alice@example.com', self: false },
      }),
      makeEvent({
        id: 'org-email',
        summary: 'Has Email Only',
        organizer: { email: 'bob@example.com', self: false },
      }),
      makeEvent({
        id: 'org-self',
        summary: 'Self Organizer',
        organizer: { self: true },
      }),
    ];
    render(<CalendarPane {...baseProps({ events })} />);

    expect(screen.getByText('Alice Example')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('always renders a Today header, with no events under it, even when other days have events', () => {
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));

    const events: CalendarEvent[] = [
      makeEvent({
        id: 'timed-day1',
        summary: 'Timed Day 1',
        start: { dateTime: '2026-09-27T10:00:00Z' },
        end: { dateTime: '2026-09-27T11:00:00Z' },
      }),
      makeEvent({
        id: 'timed-day2',
        summary: 'Timed Day 2',
        start: { dateTime: '2026-09-28T09:00:00Z' },
        end: { dateTime: '2026-09-28T10:00:00Z' },
      }),
    ];

    render(<CalendarPane {...baseProps({ events })} />);

    const headers = document.querySelectorAll('.calendar-day-header');
    expect(headers.length).toBe(3);

    const todayHeader = Array.from(headers).find((h) => /today/i.test(h.textContent ?? ''));
    expect(todayHeader).toBeTruthy();

    const todayGroup = todayHeader!.closest('.calendar-day-group')!;
    expect(todayGroup.querySelectorAll('.calendar-event-row').length).toBe(0);
    expect(todayGroup.querySelectorAll('.calendar-event-allday').length).toBe(0);
  });

  it('renders the RSVP chip group before the Scroll to today button', () => {
    render(<CalendarPane {...baseProps({ events: [] })} />);

    const scrollButton = screen.getByRole('button', { name: 'Scroll to today' });
    const acceptedButton = screen.getByRole('button', { name: 'Accepted' });
    const chipGroup = screen.getByRole('group', { name: 'RSVP Status Filters' });

    expect(
      acceptedButton.compareDocumentPosition(scrollButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const chipsContainer = document.querySelector('.calendar-rsvp-chips')!;
    expect(chipGroup).toContainElement(acceptedButton);
    expect(chipsContainer.children[0]).toBe(chipGroup);
    expect(chipsContainer.children[1]).toBe(scrollButton);
  });

  it("clicking Scroll to today scrolls today's header into view smoothly", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events = [makeEvent({})];
      render(<CalendarPane {...baseProps({ events })} />);

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('clicking Scroll to today scrolls the first current timed row into view smoothly (centered) when one is displayed', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events = [
        makeEvent({
          id: 'earlier-not-current',
          summary: 'Earlier Meeting',
          start: { dateTime: '2026-09-27T08:00:00Z' },
          end: { dateTime: '2026-09-27T09:00:00Z' },
        }),
        makeEvent({
          id: 'current-meeting',
          summary: 'Current Meeting',
          start: { dateTime: '2026-09-27T10:00:00Z' },
          end: { dateTime: '2026-09-27T11:00:00Z' },
        }),
      ];
      render(<CalendarPane {...baseProps({ events })} />);

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

      const currentRow = screen.getByText('Current Meeting').closest('.calendar-event-row')!;
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(scrollIntoView.mock.instances[0]).toBe(currentRow);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('clicking Scroll to today falls back to the Today header (smooth/start) when no current row is displayed', () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events = [makeEvent({})]; // 10:00-11:00Z, system time stubbed to 12:00Z — not current
      render(<CalendarPane {...baseProps({ events })} />);

      const headers = screen.getAllByText(/today|tomorrow|\d/i, { selector: '.calendar-day-header' });
      const todayHeader = headers.find((h) => /today/i.test(h.textContent ?? ''))!;

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
      expect(scrollIntoView.mock.instances[0]).toBe(todayHeader);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('on initial load, centers the current timed row (auto/center) when one is displayed', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events = [
        makeEvent({
          id: 'earlier-not-current',
          summary: 'Earlier Meeting',
          start: { dateTime: '2026-09-27T08:00:00Z' },
          end: { dateTime: '2026-09-27T09:00:00Z' },
        }),
        makeEvent({
          id: 'current-meeting',
          summary: 'Current Meeting',
          start: { dateTime: '2026-09-27T10:00:00Z' },
          end: { dateTime: '2026-09-27T11:00:00Z' },
        }),
      ];
      render(<CalendarPane {...baseProps({ events })} />);

      const currentRow = screen.getByText('Current Meeting').closest('.calendar-event-row')!;
      expect(currentRow).toHaveClass('calendar-event-row--selected');
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
      expect(scrollIntoView.mock.instances[0]).toBe(currentRow);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('on initial load, centers the next upcoming timed row (auto/center) when no current row is displayed', () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events: CalendarEvent[] = [
        makeEvent({
          id: 'past-event',
          summary: 'Past Meeting',
          start: { dateTime: '2026-09-27T08:00:00Z' },
          end: { dateTime: '2026-09-27T09:00:00Z' },
        }),
        makeEvent({
          id: 'future-event',
          summary: 'Future Meeting',
          start: { dateTime: '2026-09-27T14:00:00Z' },
          end: { dateTime: '2026-09-27T15:00:00Z' },
        }),
      ];

      render(<CalendarPane {...baseProps({ events })} />);

      const futureRow = screen.getByText('Future Meeting').closest('.calendar-event-row')!;
      expect(futureRow).toHaveClass('calendar-event-row--selected');
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
      expect(scrollIntoView.mock.instances[0]).toBe(futureRow);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('auto-scrolls to the Today header (auto/start) on initial load when neither a current nor future timed row is displayed', () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events = [makeEvent({})]; // 10:00-11:00Z, system time stubbed to 12:00Z — not current, in the past
      render(<CalendarPane {...baseProps({ events })} />);

      const headers = screen.getAllByText(/today|tomorrow|\d/i, { selector: '.calendar-day-header' });
      const todayHeader = headers.find((h) => /today/i.test(h.textContent ?? ''))!;

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
      expect(scrollIntoView.mock.instances[0]).toBe(todayHeader);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('clicking Scroll to today does not call onClose', () => {
    const onClose = vi.fn();
    const events = [makeEvent({})];
    render(<CalendarPane {...baseProps({ events, onClose })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks a displayed timed event current at its inclusive start boundary and clears it at its exclusive end boundary', () => {
    vi.setSystemTime(new Date('2026-09-27T09:59:00Z'));
    const event = makeEvent({
      id: 'current-evt',
      summary: 'Standup',
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    render(<CalendarPane {...baseProps({ events: [event] })} />);

    const row = screen.getByText('Standup').closest('.calendar-event-row')!;
    expect(row).not.toHaveClass('calendar-event-row--current');

    act(() => {
      vi.advanceTimersByTime(60 * 1000); // now 10:00 — inclusive start boundary
    });
    expect(row).toHaveClass('calendar-event-row--current');

    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000); // now 11:00 — exclusive end boundary
    });
    expect(row).not.toHaveClass('calendar-event-row--current');
  });

  it('never marks all-day, RSVP-hidden, or invalid-timestamp events as current', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const events: CalendarEvent[] = [
      makeEvent({
        id: 'allday-current',
        summary: 'All Day Thing',
        start: { date: '2026-09-27' },
        end: { date: '2026-09-28' },
        isAllDay: true,
      }),
      makeEvent({
        id: 'declined-current',
        summary: 'Declined But In Progress',
        start: { dateTime: '2026-09-27T10:00:00Z' },
        end: { dateTime: '2026-09-27T11:00:00Z' },
        selfResponseStatus: 'declined',
      }),
      makeEvent({
        id: 'invalid-current',
        summary: 'Invalid Timestamps',
        start: { dateTime: 'not-a-date' },
        end: { dateTime: 'also-not-a-date' },
      }),
    ];

    render(<CalendarPane {...baseProps({ events })} />);

    expect(document.querySelectorAll('.calendar-event-row--current').length).toBe(0);
    expect(screen.getByText('All Day Thing').closest('.calendar-event-allday')).not.toBeNull();
    expect(screen.queryByText('Declined But In Progress')).not.toBeInTheDocument();
    const invalidRow = screen.getByText('Invalid Timestamps').closest('.calendar-event-row')!;
    expect(invalidRow).not.toHaveClass('calendar-event-row--current');
  });

  it('does not let a stale boundary timeout affect replacement rows after events change', () => {
    const firstEvent = makeEvent({
      id: 'old-evt',
      summary: 'Old Meeting',
      start: { dateTime: '2026-09-27T12:05:00Z' },
      end: { dateTime: '2026-09-27T12:30:00Z' },
    });
    const { rerender } = render(<CalendarPane {...baseProps({ events: [firstEvent] })} />);

    const secondEvent = makeEvent({
      id: 'new-evt',
      summary: 'New Meeting',
      start: { dateTime: '2026-09-27T13:00:00Z' },
      end: { dateTime: '2026-09-27T14:00:00Z' },
    });
    rerender(<CalendarPane {...baseProps({ events: [secondEvent] })} />);

    // Advance past the old event's stale boundary (12:05) — it must not resurrect
    // or otherwise affect the replacement row.
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000); // now 12:05
    });

    expect(screen.queryByText('Old Meeting')).not.toBeInTheDocument();
    const newRow = screen.getByText('New Meeting').closest('.calendar-event-row')!;
    expect(newRow).not.toHaveClass('calendar-event-row--current');

    act(() => {
      vi.advanceTimersByTime(56 * 60 * 1000); // now 13:01, past the new event's start
    });
    expect(newRow).toHaveClass('calendar-event-row--current');
  });

  it('marks both rows current when two displayed timed events overlap the current time', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const events: CalendarEvent[] = [
      makeEvent({
        id: 'overlap-a',
        summary: 'Overlap A',
        start: { dateTime: '2026-09-27T10:00:00Z' },
        end: { dateTime: '2026-09-27T11:00:00Z' },
      }),
      makeEvent({
        id: 'overlap-b',
        summary: 'Overlap B',
        start: { dateTime: '2026-09-27T10:15:00Z' },
        end: { dateTime: '2026-09-27T11:15:00Z' },
      }),
    ];

    render(<CalendarPane {...baseProps({ events })} />);

    const rowA = screen.getByText('Overlap A').closest('.calendar-event-row')!;
    const rowB = screen.getByText('Overlap B').closest('.calendar-event-row')!;
    expect(rowA).toHaveClass('calendar-event-row--current');
    expect(rowB).toHaveClass('calendar-event-row--current');
  });

  it('gates a current declined event behind the Declined RSVP filter, and clicking scroll centers the accepted one until Declined is also selected', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events: CalendarEvent[] = [
        makeEvent({
          id: 'accepted-current',
          summary: 'Accepted Current',
          start: { dateTime: '2026-09-27T10:00:00Z' },
          end: { dateTime: '2026-09-27T11:00:00Z' },
          selfResponseStatus: 'accepted',
        }),
        makeEvent({
          id: 'declined-current',
          summary: 'Declined Current',
          start: { dateTime: '2026-09-27T10:00:00Z' },
          end: { dateTime: '2026-09-27T11:00:00Z' },
          selfResponseStatus: 'declined',
        }),
      ];

      const { rerender } = render(<CalendarPane {...baseProps({ events })} />);

      // Declined not selected: declined event is not rendered at all.
      expect(screen.queryByText('Declined Current')).not.toBeInTheDocument();
      const acceptedRow = screen.getByText('Accepted Current').closest('.calendar-event-row')!;
      expect(acceptedRow).toHaveClass('calendar-event-row--current');

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(scrollIntoView.mock.instances[0]).toBe(acceptedRow);

      // Rerender with Declined selected: the declined event may also render and be marked current.
      rerender(
        <CalendarPane
          {...baseProps({
            events,
            selectedRsvpStatuses: new Set(['accepted', 'tentative', 'needsAction', 'declined']) as RsvpSelection,
          })}
        />
      );

      const declinedRow = screen.getByText('Declined Current').closest('.calendar-event-row')!;
      expect(declinedRow).toHaveClass('calendar-event-row--current');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('clicking Scroll to today centers the next upcoming timed row (smooth/center) when no current row is displayed', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events: CalendarEvent[] = [
        makeEvent({
          id: 'past-event',
          summary: 'Past Meeting',
          start: { dateTime: '2026-09-27T08:00:00Z' },
          end: { dateTime: '2026-09-27T09:00:00Z' },
        }),
        makeEvent({
          id: 'future-event',
          summary: 'Future Meeting',
          start: { dateTime: '2026-09-27T14:00:00Z' },
          end: { dateTime: '2026-09-27T15:00:00Z' },
        }),
      ];

      render(<CalendarPane {...baseProps({ events })} />);

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

      const futureRow = screen.getByText('Future Meeting').closest('.calendar-event-row')!;
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(scrollIntoView.mock.instances[0]).toBe(futureRow);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('skips an RSVP-filtered-out future event when centering the next upcoming row, targeting the next visible one instead', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events: CalendarEvent[] = [
        makeEvent({
          id: 'declined-future',
          summary: 'Declined Future Meeting',
          start: { dateTime: '2026-09-27T12:00:00Z' },
          end: { dateTime: '2026-09-27T13:00:00Z' },
          selfResponseStatus: 'declined',
        }),
        makeEvent({
          id: 'accepted-future',
          summary: 'Accepted Future Meeting',
          start: { dateTime: '2026-09-27T14:00:00Z' },
          end: { dateTime: '2026-09-27T15:00:00Z' },
          selfResponseStatus: 'accepted',
        }),
      ];

      render(<CalendarPane {...baseProps({ events })} />);

      expect(screen.queryByText('Declined Future Meeting')).not.toBeInTheDocument();

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

      const acceptedRow = screen.getByText('Accepted Future Meeting').closest('.calendar-event-row')!;
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(scrollIntoView.mock.instances[0]).toBe(acceptedRow);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('never targets an all-day future event when centering the next upcoming row, falling back to the Today header', () => {
    vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const events: CalendarEvent[] = [
        makeEvent({
          id: 'allday-future',
          summary: 'All Day Future Thing',
          start: { date: '2026-09-27' },
          end: { date: '2026-09-28' },
          isAllDay: true,
        }),
      ];

      render(<CalendarPane {...baseProps({ events })} />);

      const headers = screen.getAllByText(/today|tomorrow|\d/i, { selector: '.calendar-day-header' });
      const todayHeader = headers.find((h) => /today/i.test(h.textContent ?? ''))!;

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
      expect(scrollIntoView.mock.instances[0]).toBe(todayHeader);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('does not throw or leave a dangling timer effect when unmounted before a pending boundary fires', () => {
    const event = makeEvent({
      id: 'pending-boundary',
      summary: 'Pending Boundary',
      start: { dateTime: '2026-09-27T12:30:00Z' },
      end: { dateTime: '2026-09-27T13:00:00Z' },
    });
    const { unmount } = render(<CalendarPane {...baseProps({ events: [event] })} />);

    unmount();

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(60 * 60 * 1000);
      });
    }).not.toThrow();
  });

  describe('idle auto-recenter', () => {
    function renderWithCurrentEvent() {
      const scrollIntoView = vi.fn();
      const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = scrollIntoView;

      vi.setSystemTime(new Date('2026-09-27T10:30:00Z'));
      const events = [
        makeEvent({
          id: 'current-meeting',
          summary: 'Current Meeting',
          start: { dateTime: '2026-09-27T10:00:00Z' },
          end: { dateTime: '2026-09-27T11:00:00Z' },
        }),
      ];
      render(<CalendarPane {...baseProps({ events })} />);
      const currentRow = screen.getByText('Current Meeting').closest('.calendar-event-row')!;
      scrollIntoView.mockClear();

      return { scrollIntoView, currentRow, restore: () => (HTMLElement.prototype.scrollIntoView = originalScrollIntoView) };
    }

    it('recenters after 30s of inactivity, centered on the current event row', () => {
      const { scrollIntoView, currentRow, restore } = renderWithCurrentEvent();
      try {
        act(() => {
          vi.advanceTimersByTime(30000);
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
        expect(scrollIntoView.mock.instances[0]).toBe(currentRow);
      } finally {
        restore();
      }
    });

    it('activity before 30s resets the idle timer', () => {
      const { scrollIntoView, restore } = renderWithCurrentEvent();
      try {
        act(() => {
          vi.advanceTimersByTime(29999);
        });
        act(() => {
          fireEvent.mouseMove(window);
        });
        act(() => {
          vi.advanceTimersByTime(29999);
        });
        expect(scrollIntoView).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it('keydown and click activity also reset the idle timer (scroll/touchstart share the same onActivity handler)', () => {
      const { scrollIntoView, restore } = renderWithCurrentEvent();
      try {
        act(() => {
          vi.advanceTimersByTime(29999);
        });
        act(() => {
          fireEvent.keyDown(window);
        });
        act(() => {
          vi.advanceTimersByTime(29999);
        });
        expect(scrollIntoView).not.toHaveBeenCalled();

        act(() => {
          fireEvent.click(window);
        });
        act(() => {
          vi.advanceTimersByTime(29999);
        });
        expect(scrollIntoView).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it('activity right after an idle recenter does not immediately trigger a second recenter, but a fresh 30s of silence does', () => {
      const { scrollIntoView, restore } = renderWithCurrentEvent();
      try {
        act(() => {
          vi.advanceTimersByTime(30000);
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);

        act(() => {
          fireEvent.mouseMove(window);
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(30000);
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(2);
        expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'center' });
      } finally {
        restore();
      }
    });

    describe('repeat auto-recenter on boundary wake while idle', () => {
      // Back-to-back meetings on the same day: meeting A is current at mount
      // and ends exactly when meeting B starts, so the two events collapse
      // onto a single first boundary (A's end == B's start, per the
      // component's strict `>` boundary math). Meeting B is still in the
      // future at that first boundary, and its own end is the second
      // boundary, after which no third event exists (today-header fallback).
      function renderWithBackToBackEvents(systemTime: string) {
        const scrollIntoView = vi.fn();
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        HTMLElement.prototype.scrollIntoView = scrollIntoView;

        vi.setSystemTime(new Date(systemTime));
        const events = [
          makeEvent({
            id: 'meeting-a',
            summary: 'Meeting A',
            start: { dateTime: '2026-09-27T10:00:00Z' },
            end: { dateTime: '2026-09-27T11:00:00Z' },
          }),
          makeEvent({
            id: 'meeting-b',
            summary: 'Meeting B',
            start: { dateTime: '2026-09-27T11:00:00Z' },
            end: { dateTime: '2026-09-27T12:00:00Z' },
          }),
        ];
        render(<CalendarPane {...baseProps({ events })} />);
        const rowA = screen.getByText('Meeting A').closest('.calendar-event-row')!;
        const rowB = screen.getByText('Meeting B').closest('.calendar-event-row')!;
        const todayHeader = document.querySelector('.calendar-day-header')!;
        scrollIntoView.mockClear();

        return {
          scrollIntoView,
          rowA,
          rowB,
          todayHeader,
          restore: () => (HTMLElement.prototype.scrollIntoView = originalScrollIntoView),
        };
      }

      it('recenters again on the next boundary crossing while still idle, then again on the boundary after that', () => {
        const { scrollIntoView, rowA, rowB, todayHeader, restore } = renderWithBackToBackEvents(
          '2026-09-27T10:30:00Z'
        );
        try {
          // 30s of inactivity: idle fires, centers on meeting A (current).
          act(() => {
            vi.advanceTimersByTime(30000);
          });
          expect(scrollIntoView).toHaveBeenCalledTimes(1);
          expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
          expect(scrollIntoView.mock.instances[0]).toBe(rowA);

          // Advance to the first boundary (11:00 — A ends / B starts). No
          // activity in between, so idleRecenteredRef is still true and the
          // boundary wake recenters again, now onto meeting B.
          act(() => {
            vi.advanceTimersByTime(30 * 60 * 1000 - 30000);
          });
          act(() => {
            vi.runOnlyPendingTimers();
          });
          expect(scrollIntoView).toHaveBeenCalledTimes(2);
          expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'center' });
          expect(scrollIntoView.mock.instances[1]).toBe(rowB);

          // Advance to the second boundary (12:00 — B ends). Still idle, so
          // it recenters a third time; with no events left, it falls back
          // to the today header.
          act(() => {
            vi.advanceTimersByTime(60 * 60 * 1000);
          });
          act(() => {
            vi.runOnlyPendingTimers();
          });
          expect(scrollIntoView).toHaveBeenCalledTimes(3);
          expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' });
          expect(scrollIntoView.mock.instances[2]).toBe(todayHeader);
        } finally {
          restore();
        }
      });

      it('does not auto-recenter on a boundary crossing when not idle', () => {
        // Mount 10s before the first boundary so the boundary fires well
        // before the 30s idle timeout ever elapses.
        const { scrollIntoView, restore } = renderWithBackToBackEvents('2026-09-27T10:59:50Z');
        try {
          act(() => {
            vi.advanceTimersByTime(10000); // now 11:00 — first boundary, idleRecenteredRef still false
          });
          expect(scrollIntoView).not.toHaveBeenCalled();
        } finally {
          restore();
        }
      });
    });

    it('removes all 5 window activity listeners on unmount, matching each addEventListener call', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      const event = makeEvent({
        id: 'listener-cleanup',
        summary: 'Listener Cleanup',
        start: { dateTime: '2026-09-27T12:30:00Z' },
        end: { dateTime: '2026-09-27T13:00:00Z' },
      });
      const { unmount } = render(<CalendarPane {...baseProps({ events: [event] })} />);

      unmount();

      const activityTypes = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
      for (const type of activityTypes) {
        const addedCount = addSpy.mock.calls.filter((call) => call[0] === type).length;
        const removedCount = removeSpy.mock.calls.filter((call) => call[0] === type).length;
        expect(removedCount).toBe(addedCount);
        expect(addedCount).toBeGreaterThan(0);
      }

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('clears the pending 30s idle timeout on unmount, so advancing past it afterward does not throw or recenter', () => {
      const scrollIntoView = vi.fn();
      const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = scrollIntoView;

      const event = makeEvent({
        id: 'idle-timeout-cleanup',
        summary: 'Idle Timeout Cleanup',
        start: { dateTime: '2026-09-27T12:30:00Z' },
        end: { dateTime: '2026-09-27T13:00:00Z' },
      });

      try {
        const { unmount } = render(<CalendarPane {...baseProps({ events: [event] })} />);
        scrollIntoView.mockClear();

        unmount();

        expect(() => {
          act(() => {
            vi.advanceTimersByTime(30000);
          });
        }).not.toThrow();
        expect(scrollIntoView).not.toHaveBeenCalled();
      } finally {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      }
    });
  });

  describe('title popup', () => {
    const evtA = makeEvent({ id: 'a', summary: 'Alpha', htmlLink: 'https://cal.test/a', joinUrl: 'https://meet.test/a' });
    const evtB = makeEvent({ id: 'b', summary: 'Beta', htmlLink: 'https://cal.test/b' });
    let popup: {
      closed: boolean;
      location: { href: string };
      focus: ReturnType<typeof vi.fn>;
      opener: unknown;
    };

    beforeEach(() => {
      popup = { closed: false, location: { href: '' }, focus: vi.fn(), opener: {} };
      (window.open as ReturnType<typeof vi.fn>).mockReturnValue(popup);
      setWidth(1200);
      setWin({ screenX: 0, screenY: 0, outerWidth: 1400, outerHeight: 900 });
    });
    afterEach(() => setWidth(1024));

    const title = (name: string) => screen.getByRole('link', { name });

    it('desktop plain left click opens named popup, prevents default, focuses, nulls opener', () => {
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      const notPrevented = fireEvent.click(title('Alpha'));
      expect(notPrevented).toBe(false);
      expect(window.open).toHaveBeenCalledTimes(1);
      const [url, name, features] = (window.open as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://cal.test/a');
      expect(name).toBe(POPUP_NAME);
      expect(features).toContain('popup');
      expect(features).toContain('width=560');
      expect(features).toContain('height=760');
      expect(features).toContain('left=');
      expect(features).toContain('top=');
      expect(popup.focus).toHaveBeenCalledTimes(1);
      expect(popup.opener).toBeNull();
    });

    it('centers over app window, rounds, clamps to >= 0', () => {
      let view = render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      setWin({ screenX: 100, screenY: 50, outerWidth: 1400, outerHeight: 900 });
      fireEvent.click(title('Alpha'));
      let features = (window.open as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(features).toContain('left=520');
      expect(features).toContain('top=120');

      view.unmount();
      view = render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      setWin({ screenX: 100, screenY: 50, outerWidth: 1401, outerHeight: 900 });
      fireEvent.click(title('Alpha'));
      features = (window.open as ReturnType<typeof vi.fn>).mock.calls[1][2];
      expect(features).toMatch(/left=\d+(,|$)/);

      view.unmount();
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      setWin({ screenX: 0, screenY: 0, outerWidth: 400, outerHeight: 300 });
      fireEvent.click(title('Alpha'));
      features = (window.open as ReturnType<typeof vi.fn>).mock.calls[2][2];
      expect(features).toContain('left=0');
      expect(features).toContain('top=0');
    });

    it('navigates and focuses the existing popup for different events', () => {
      let navigatedUrl = '';
      const existingPopup = {
        closed: false,
        focus: vi.fn(),
        opener: {},
      };
      Object.defineProperty(existingPopup, 'location', {
        set(url: string) {
          navigatedUrl = url;
        },
        get() {
          throw new DOMException('Cross-origin access denied', 'SecurityError');
        },
      });
      (window.open as ReturnType<typeof vi.fn>).mockReturnValue(existingPopup);
      render(<CalendarPane {...baseProps({ events: [evtA, evtB] })} />);
      fireEvent.click(title('Alpha'));
      fireEvent.click(title('Beta'));
      const calls = (window.open as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe('https://cal.test/a');
      expect(calls[0][1]).toBe(POPUP_NAME);
      expect(calls).toHaveLength(1);
      expect(navigatedUrl).toBe('https://cal.test/b');
      expect(existingPopup.focus).toHaveBeenCalledTimes(2);
    });

    it('opens a replacement popup after the existing one closes', () => {
      const existingPopup = {
        closed: false,
        location: { href: 'https://cal.test/a' },
        focus: vi.fn(),
        opener: {},
      };
      const replacementPopup = { focus: vi.fn(), opener: {} };
      (window.open as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(existingPopup)
        .mockReturnValue(replacementPopup);
      render(<CalendarPane {...baseProps({ events: [evtA, evtB] })} />);
      fireEvent.click(title('Alpha'));
      existingPopup.closed = true;
      fireEvent.click(title('Beta'));

      expect(window.open).toHaveBeenCalledTimes(2);
      expect((window.open as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('https://cal.test/b');
      expect(replacementPopup.focus).toHaveBeenCalledTimes(1);
    });

    it('falls back to _blank when popup blocked', () => {
      (window.open as ReturnType<typeof vi.fn>).mockReturnValue(null);
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      expect(() => fireEvent.click(title('Alpha'))).not.toThrow();
      const calls = (window.open as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(['https://cal.test/a', '_blank']);
    });

    it('does not throw when setting opener throws; still focuses', () => {
      const p = {
        focus: vi.fn(),
        set opener(_v: unknown) {
          throw new Error('nope');
        },
        get opener() {
          return {};
        },
      };
      (window.open as ReturnType<typeof vi.fn>).mockReturnValue(p);
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      expect(() => fireEvent.click(title('Alpha'))).not.toThrow();
      expect(p.focus).toHaveBeenCalledTimes(1);
    });

    it('breakpoint: 960 popup; 959 and 500 native', () => {
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      act(() => setWidth(960));
      expect(fireEvent.click(title('Alpha'))).toBe(false);
      expect(window.open).toHaveBeenCalledTimes(1);
      for (const w of [959, 500]) {
        act(() => setWidth(w));
        expect(fireEvent.click(title('Alpha'))).toBe(true);
      }
      expect(window.open).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['ctrl', { ctrlKey: true }],
      ['meta', { metaKey: true }],
      ['shift', { shiftKey: true }],
      ['alt', { altKey: true }],
      ['middle button', { button: 1 }],
    ])('%s click on desktop is native', (_n, init) => {
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      expect(fireEvent.click(title('Alpha'), init)).toBe(true);
      expect(window.open).not.toHaveBeenCalled();
    });

    it('Join click does not open popup and keeps own href/target', () => {
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      const join = screen.getByRole('link', { name: /^join$/i });
      fireEvent.click(join);
      expect(window.open).not.toHaveBeenCalled();
      expect(join).toHaveAttribute('href', 'https://meet.test/a');
      expect(join).toHaveAttribute('target', '_blank');
    });

    it('title anchor keeps href, target, rel', () => {
      render(<CalendarPane {...baseProps({ events: [evtA] })} />);
      const a = title('Alpha');
      expect(a).toHaveAttribute('href', 'https://cal.test/a');
      expect(a).toHaveAttribute('target', '_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('rel')).toContain('noreferrer');
    });

    it('all-day event renders no title anchor', () => {
      const allDay = makeEvent({ id: 'ad', summary: 'AllDay', isAllDay: true, start: { date: '2026-09-27' }, end: { date: '2026-09-28' } });
      render(<CalendarPane {...baseProps({ events: [allDay] })} />);
      expect(screen.queryByRole('link', { name: 'AllDay' })).not.toBeInTheDocument();
    });
  });
  describe('insert link icon', () => {
    const timed = makeEvent({ id: 't', summary: 'Timed Talk', htmlLink: 'https://cal.test/t', joinUrl: 'https://meet.test/t' });
    const allDay = makeEvent({
      id: 'd',
      summary: 'Offsite Day',
      start: { date: '2026-09-27' },
      end: { date: '2026-09-28' },
      isAllDay: true,
      htmlLink: 'https://cal.test/d',
    });
    const user = () => userEvent.setup({ delay: null });
    const btnName = (t: string) => `Insert "${t}" link into note`;
    const enabled = (over: PaneTestOverrides = {}) =>
      baseProps({
        events: [timed, allDay],
        canInsertCalendarEventLink: true,
        onInsertCalendarEventLink: vi.fn(),
        ...over,
      });

    beforeEach(() => {
      // userEvent's internal async waits deadlock under fake timers.
      vi.useRealTimers();
      setWidth(1200);
      setWin({ screenX: 0, screenY: 0, outerWidth: 1400, outerHeight: 900 });
    });
    afterEach(() => setWidth(1024));

    it('exposes one named button per timed and all-day event; svg hidden from a11y tree', () => {
      render(<CalendarPane {...enabled()} />);
      for (const t of ['Timed Talk', 'Offsite Day']) {
        const btns = screen.getAllByRole('button', { name: btnName(t) });
        expect(btns).toHaveLength(1);
        expect(btns[0]).toHaveAttribute('type', 'button');
        expect(btns[0]).toHaveAttribute('data-calendar-insert-link');
        expect(btns[0]).toHaveAttribute('title', btnName(t));
        expect(btns[0].querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      }
      for (const action of screen.getAllByRole('button', { name: /^Insert "/ })) {
        expect(within(action).queryAllByRole('img')).toHaveLength(0);
      }
      expect(screen.getAllByRole('img', { name: 'accepted', exact: true })).toHaveLength(2);
    });

    it('click passes title and url exactly once', async () => {
      const onInsert = vi.fn();
      render(<CalendarPane {...enabled({ onInsertCalendarEventLink: onInsert })} />);
      await user().click(screen.getByRole('button', { name: btnName('Timed Talk') }));
      expect(onInsert).toHaveBeenCalledTimes(1);
      expect(onInsert).toHaveBeenCalledWith('Timed Talk', 'https://cal.test/t');
      await user().click(screen.getByRole('button', { name: btnName('Offsite Day') }));
      expect(onInsert).toHaveBeenCalledTimes(2);
      expect(onInsert).toHaveBeenLastCalledWith('Offsite Day', 'https://cal.test/d');
      expect(window.open).not.toHaveBeenCalled();
    });

    it('Enter and Space each activate once; Tab reaches the button', async () => {
      const onInsert = vi.fn();
      render(<CalendarPane {...enabled({ events: [timed], onInsertCalendarEventLink: onInsert })} />);
      const u = user();
      const btn = screen.getByRole('button', { name: btnName('Timed Talk') });
      await u.tab(); // scroll-today
      for (let i = 0; i < 10 && document.activeElement !== btn; i++) await u.tab();
      expect(btn).toHaveFocus();
      await u.keyboard('{Enter}');
      expect(onInsert).toHaveBeenCalledTimes(1);
      await u.keyboard(' ');
      expect(onInsert).toHaveBeenCalledTimes(2);
      expect(onInsert).toHaveBeenNthCalledWith(2, 'Timed Talk', 'https://cal.test/t');
    });

    it('passes trimmed url for both kinds', async () => {
      const onInsert = vi.fn();
      render(
        <CalendarPane
          {...enabled({
            events: [{ ...timed, htmlLink: '  https://cal.test/t  ' }, { ...allDay, htmlLink: '\n https://cal.test/d\t' }],
            onInsertCalendarEventLink: onInsert,
          })}
        />
      );
      await user().click(screen.getByRole('button', { name: btnName('Timed Talk') }));
      await user().click(screen.getByRole('button', { name: btnName('Offsite Day') }));
      expect(onInsert).toHaveBeenNthCalledWith(1, 'Timed Talk', 'https://cal.test/t');
      expect(onInsert).toHaveBeenNthCalledWith(2, 'Offsite Day', 'https://cal.test/d');
    });

    it('no button when disabled, even with action supplied', () => {
      const onInsert = vi.fn();
      render(<CalendarPane {...enabled({ canInsertCalendarEventLink: false, onInsertCalendarEventLink: onInsert })} />);
      expect(document.querySelector('[data-calendar-insert-link]')).toBeNull();
      expect(onInsert).not.toHaveBeenCalled();
    });

    it('no button when enabled flag set but action missing', () => {
      render(<CalendarPane {...enabled({ onInsertCalendarEventLink: undefined })} />);
      expect(document.querySelector('[data-calendar-insert-link]')).toBeNull();
    });

    it.each([undefined, '', '   ', '\n\t'])('no button and no blank anchor for htmlLink %j', (link) => {
      const onInsert = vi.fn();
      render(
        <CalendarPane
          {...enabled({
            events: [
              { ...timed, htmlLink: link as unknown as string },
              { ...allDay, htmlLink: link as unknown as string },
            ],
            onInsertCalendarEventLink: onInsert,
          })}
        />
      );
      expect(document.querySelector('[data-calendar-insert-link]')).toBeNull();
      expect(onInsert).not.toHaveBeenCalled();
      expect(document.querySelector('a.calendar-event-title-link')).toBeNull();
      expect(screen.getByText('Timed Talk')).toBeInTheDocument();
    });

    it('timed title keeps link attrs and popup; clicking it does not insert; Join unchanged; all-day title is text', () => {
      const popup = { focus: vi.fn(), opener: {} };
      (window.open as ReturnType<typeof vi.fn>).mockReturnValue(popup);
      const onInsert = vi.fn();
      render(<CalendarPane {...enabled({ onInsertCalendarEventLink: onInsert })} />);
      const a = screen.getByRole('link', { name: 'Timed Talk' });
      expect(a).toHaveAttribute('href', 'https://cal.test/t');
      expect(a).toHaveAttribute('target', '_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
      fireEvent.click(a);
      expect(window.open).toHaveBeenCalledTimes(1);
      expect((window.open as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(POPUP_NAME);
      expect(onInsert).not.toHaveBeenCalled();
      const join = screen.getByRole('link', { name: /^join$/i });
      expect(join).toHaveAttribute('href', 'https://meet.test/t');
      expect(join).toHaveAttribute('target', '_blank');
      fireEvent.click(join);
      expect(window.open).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('link', { name: 'Offsite Day' })).not.toBeInTheDocument();
      expect(screen.getByText('Offsite Day')).toBeInTheDocument();
    });
  });

  describe('RSVP toggle scroll anchor', () => {
    const H = 30;
    const EV = 50;
    const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
    const [A, B, C, D] = DAYS;
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollEl: HTMLElement;
    let scrollTop = 0;

    function dayEvent(day: string, status: 'accepted' | 'tentative') {
      return makeEvent({
        id: `e-${day}`,
        summary: `Event ${day}`,
        selfResponseStatus: status,
        start: { dateTime: `${day}T12:00:00` },
        end: { dateTime: `${day}T13:00:00` },
      });
    }

    function installGeometry() {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const rect = (top: number) => ({ top, bottom: top + H, left: 0, right: 0, width: 0, height: H, x: 0, y: top, toJSON() {} }) as DOMRect;
        if (this.classList.contains('calendar-pane-scroll')) return rect(0);
        if (this.classList.contains('calendar-day-header')) {
          const groups = Array.from(document.querySelectorAll('.calendar-day-group'));
          const idx = groups.indexOf(this.closest('.calendar-day-group')!);
          let y = 0;
          for (let i = 0; i < idx; i++) y += H + EV * groups[i].querySelectorAll('a[href]').length;
          return rect(y - scrollTop);
        }
        return origRect.call(this);
      });
    }

    function headerFor(day: string) {
      const label = Array.from(document.querySelectorAll('.calendar-day-header'))
        .find((h) => h.closest('.calendar-day-group')?.querySelector('a[href]')?.textContent?.includes(day));
      return label as HTMLElement | undefined;
    }
    const offsetOf = (day: string) => headerFor(day)!.getBoundingClientRect().top - 0;

    function setup(statuses: Array<'accepted' | 'tentative'>, initial: RsvpSelection, withEvents = true) {
      installGeometry();
      const props = baseProps({ events: withEvents ? DAYS.map((d, i) => dayEvent(d, statuses[i])) : [] });
      let setSel!: (s: RsvpSelection) => void;
      function Host() {
        const [sel, setSelection] = useState(initial);
        setSel = setSelection;
        return <CalendarPane {...props} selectedRsvpStatuses={sel} onRsvpStatusesChange={setSelection} />;
      }
      const { container } = render(<Host />);
      scrollEl = container.querySelector('.calendar-pane-scroll') as HTMLElement;
      scrollTop = 0;
      Object.defineProperty(scrollEl, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => { scrollTop = v; },
      });
      return { setSel: (s: RsvpSelection) => act(() => setSel(s)) };
    }

    function anchorOn(day: string, offset: number) {
      scrollTop = 0;
      scrollTop = headerFor(day)!.getBoundingClientRect().top - offset;
      fireEvent.scroll(scrollEl);
      expect(offsetOf(day)).toBe(offset);
    }

    const clickMaybe = () => fireEvent.click(screen.getByRole('button', { name: 'Maybe' }));
    const selWith = (...s: Array<'accepted' | 'tentative' | 'needsAction'>) => new Set(s) as RsvpSelection;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('keeps first visible header offset when earlier days are hidden', () => {
      setup(['accepted', 'tentative', 'accepted', 'accepted'], selWith('accepted', 'tentative'));
      anchorOn(C, 40);
      // B tentative hidden; make A tentative too via separate scenario below
      clickMaybe();
      expect(headerFor(B)).toBeUndefined();
      expect(offsetOf(C)).toBe(40);
    });

    it('hides multiple earlier days (A and B) and keeps offset', () => {
      setup(['tentative', 'tentative', 'accepted', 'accepted'], selWith('accepted', 'tentative'));
      anchorOn(C, 40);
      clickMaybe();
      expect(headerFor(A)).toBeUndefined();
      expect(headerFor(B)).toBeUndefined();
      expect(offsetOf(C)).toBe(40);
    });

    it('anchors to the next following day when the anchor day is hidden', () => {
      setup(['accepted', 'accepted', 'tentative', 'accepted'], selWith('accepted', 'tentative'));
      anchorOn(C, 40);
      const dOffsetBefore = offsetOf(D);
      clickMaybe();
      expect(headerFor(C)).toBeUndefined();
      expect(offsetOf(D)).toBe(dOffsetBefore);
    });

    it('anchors to the nearest previous day when anchor and all later days are hidden', () => {
      setup(['tentative', 'accepted', 'tentative', 'tentative'], selWith('accepted', 'tentative'));
      anchorOn(C, 40);
      const bOffsetBefore = offsetOf(B);
      clickMaybe();
      expect(headerFor(A)).toBeUndefined();
      expect(headerFor(C)).toBeUndefined();
      expect(headerFor(D)).toBeUndefined();
      expect(offsetOf(B)).toBe(bOffsetBefore);
    });

    it('keeps offset when a toggle re-adds earlier days', () => {
      setup(['tentative', 'tentative', 'accepted', 'accepted'], selWith('accepted'));
      expect(headerFor(A)).toBeUndefined();
      // offset 0 (not 40): the always-present today group would otherwise be the real first visible header
      anchorOn(C, 0);
      clickMaybe();
      expect(headerFor(A)).toBeDefined();
      expect(offsetOf(C)).toBe(0);
    });

    it('does not touch scrollTop when no scroll event has occurred', () => {
      setup(['tentative', 'tentative', 'accepted', 'accepted'], selWith('accepted', 'tentative'));
      scrollTop = 123;
      clickMaybe();
      expect(scrollTop).toBe(123);
    });

    it('does not touch scrollTop when there are no events', () => {
      setup([], selWith('accepted', 'tentative'), false);
      scrollTop = 77;
      fireEvent.scroll(scrollEl);
      clickMaybe();
      expect(scrollTop).toBe(77);
    });

    it('anchors on external selectedRsvpStatuses change without a click', () => {
      const { setSel } = setup(['tentative', 'tentative', 'accepted', 'accepted'], selWith('accepted', 'tentative'));
      anchorOn(C, 40);
      setSel(selWith('accepted'));
      expect(headerFor(A)).toBeUndefined();
      expect(offsetOf(C)).toBe(40);
    });
  });
});
