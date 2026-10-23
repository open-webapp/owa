import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import type { CalendarInfo, Source } from '../../core/types.js';
import { createFakeController, makeEvent, type RsvpSelection } from './helpers.js';

const A: Source = { id: 'a', email: 'a@example.com' };
const B: Source = { id: 'b', email: 'b@example.com' };
const DEFAULT: RsvpSelection = new Set(['accepted', 'tentative', 'needsAction']);

const calsA: CalendarInfo[] = [
  { id: 'a-primary', summary: 'A Work', primary: true, accessRole: 'owner' },
  { id: 'a-team', summary: 'A Team', primary: false, accessRole: 'reader' },
];
const calsB: CalendarInfo[] = [
  { id: 'b-primary', summary: 'B Home', primary: true, accessRole: 'owner' },
  { id: 'b-misc', summary: 'B Misc', primary: false, accessRole: 'reader' },
];

function paneProps(over: Record<string, unknown> = {}) {
  return { selectedRsvpStatuses: DEFAULT, onRsvpStatusesChange: vi.fn(), ...over };
}

describe('CalendarPane with sources', () => {
  beforeEach(() => {
    vi.stubGlobal('open', vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with 2 sources, line 3 shows "organizer · account email" and a color dot', () => {
    const controller = createFakeController({
      sources: [A, B],
      events: [
        makeEvent({ id: 'e1', sourceId: 'a', summary: 'Alpha Event', organizer: { displayName: 'Alice Example', self: false } }),
        makeEvent({ id: 'e2', sourceId: 'b', summary: 'Beta Event', organizer: { displayName: 'Bob Example', self: false } }),
      ],
    });
    render(<CalendarPane {...paneProps({ sources: [A, B], controller })} />);

    const rowA = screen.getByText('Alpha Event').closest('.calendar-event-row')!;
    const rowB = screen.getByText('Beta Event').closest('.calendar-event-row')!;
    expect(rowA).toHaveTextContent('Alice Example · a@example.com');
    expect(rowB).toHaveTextContent('Bob Example · b@example.com');

    const dotA = rowA.querySelector('.calendar-event-source-dot') as HTMLElement;
    const dotB = rowB.querySelector('.calendar-event-source-dot') as HTMLElement;
    expect(dotA).not.toBeNull();
    expect(dotB).not.toBeNull();
    expect(dotA.style.backgroundColor).not.toBe('');
    expect(dotA.style.backgroundColor).not.toBe(dotB.style.backgroundColor);
  });

  it('with 1 source, shows the organizer only: no account email and no dot', () => {
    const controller = createFakeController({
      sources: [A],
      events: [makeEvent({ id: 'e1', sourceId: 'a', summary: 'Solo Event', organizer: { displayName: 'Alice Example', self: false } })],
    });
    render(<CalendarPane {...paneProps({ sources: [A], controller })} />);

    const row = screen.getByText('Solo Event').closest('.calendar-event-row')!;
    expect(row).toHaveTextContent('Alice Example');
    expect(row).not.toHaveTextContent('a@example.com');
    expect(row).not.toHaveTextContent('·');
    expect(row.querySelector('.calendar-event-source-dot')).toBeNull();
  });

  it('merges events from every ok source', () => {
    const controller = createFakeController({
      sources: [A, B],
      events: [
        makeEvent({ id: 'e1', sourceId: 'a', summary: 'Alpha Event' }),
        makeEvent({ id: 'e1', sourceId: 'b', summary: 'Beta Event' }),
      ],
    });
    render(<CalendarPane {...paneProps({ sources: [A, B], controller })} />);
    expect(screen.getByText('Alpha Event')).toBeInTheDocument();
    expect(screen.getByText('Beta Event')).toBeInTheDocument();
  });

  it('selector groups calendars under a heading per account', () => {
    const controller = createFakeController({
      sources: [A, B],
      calendars: { a: calsA, b: calsB },
      selected: { a: ['a-primary'], b: ['b-primary'] },
    });
    render(<CalendarPane {...paneProps({ sources: [A, B], controller })} />);

    for (const combo of screen.getAllByRole('combobox')) fireEvent.click(combo);

    const headingA = screen.getByRole('heading', { name: 'a@example.com' });
    const headingB = screen.getByRole('heading', { name: 'b@example.com' });
    const optionNames = screen.getAllByRole('option').map((o) => o.textContent);
    expect(optionNames).toEqual(['A Work', 'A Team', 'B Home', 'B Misc']);
    // Document order: heading A, A's options, heading B, B's options.
    expect(headingA.compareDocumentPosition(screen.getByRole('option', { name: 'A Work' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('option', { name: 'A Team' }).compareDocumentPosition(headingB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(headingB.compareDocumentPosition(screen.getByRole('option', { name: 'B Home' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Clear in one account keeps that account\'s primary and leaves the other account untouched', () => {
    const controller = createFakeController({
      sources: [A, B],
      calendars: { a: calsA, b: calsB },
      selected: { a: ['a-primary', 'a-team'], b: ['b-primary', 'b-misc'] },
    });
    render(<CalendarPane {...paneProps({ sources: [A, B], controller })} />);

    for (const combo of screen.getAllByRole('combobox')) fireEvent.click(combo);
    // First Clear in document order belongs to account A.
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]);

    expect(controller.getSelectedIds('a')).toEqual(['a-primary']);
    expect(controller.getSelectedIds('b')).toEqual(['b-primary', 'b-misc']);
  });

  it('renders the renderEventAction slot once per event (timed and all-day)', () => {
    const controller = createFakeController({
      sources: [A],
      events: [
        makeEvent({ id: 't1', sourceId: 'a', summary: 'Timed One' }),
        makeEvent({ id: 'd1', sourceId: 'a', summary: 'Day One', isAllDay: true, start: { date: '2026-09-27' }, end: { date: '2026-09-28' } }),
      ],
    });
    const renderEventAction = vi.fn((event: { id: string }) => <button data-testid="slot">act {event.id}</button>);
    render(<CalendarPane {...paneProps({ sources: [A], controller, renderEventAction })} />);

    const slots = screen.getAllByTestId('slot');
    expect(slots.map((s) => s.textContent).sort()).toEqual(['act d1', 'act t1']);
    expect(within(screen.getByText('Timed One').closest('.calendar-event-row') as HTMLElement).getByTestId('slot')).toHaveTextContent('act t1');
    expect(within(screen.getByText('Day One').closest('.calendar-event-allday') as HTMLElement).getByTestId('slot')).toHaveTextContent('act d1');
  });

  it('renders nothing for an event whose renderEventAction returns null', () => {
    const controller = createFakeController({
      sources: [A],
      events: [makeEvent({ id: 't1', sourceId: 'a', summary: 'Timed One' })],
    });
    render(<CalendarPane {...paneProps({ sources: [A], controller, renderEventAction: () => null })} />);
    expect(screen.getByText('Timed One')).toBeInTheDocument();
    const row = screen.getByText('Timed One').closest('.calendar-event-row')!;
    expect(within(row as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('shows sourceNotice for a needs-scope source while the other source\'s events still render', () => {
    const controller = createFakeController({
      sources: [A, B],
      status: { a: 'needs-scope', b: 'ok' },
      events: [makeEvent({ id: 'e2', sourceId: 'b', summary: 'Beta Event' })],
    });
    const sourceNotice = vi.fn((s: Source) => <p>Reconnect {s.email}</p>);
    render(<CalendarPane {...paneProps({ sources: [A, B], controller, sourceNotice })} />);

    expect(screen.getByText('Reconnect a@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Reconnect b@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('Beta Event')).toBeInTheDocument();
    expect(sourceNotice).not.toHaveBeenCalledWith(B);
  });

  it('shows sourceNotice(source) output for a needs-scope source with no events', () => {
    const controller = createFakeController({ sources: [A], status: { a: 'needs-scope' } });
    render(<CalendarPane {...paneProps({ sources: [A], controller, sourceNotice: (s: Source) => <p>Grant access for {s.email}</p> })} />);
    expect(screen.getByText('Grant access for a@example.com')).toBeInTheDocument();
  });

  it('renders emptyState when there are zero sources', () => {
    const controller = createFakeController({ sources: [] });
    render(<CalendarPane {...paneProps({ sources: [], controller, emptyState: <p>Connect an account</p> })} />);
    expect(screen.getByText('Connect an account')).toBeInTheDocument();
    expect(document.querySelectorAll('.calendar-day-header').length).toBe(0);
  });

  it('an errored source renders the error notice (not a crash) while other sources still render', () => {
    const controller = createFakeController({
      sources: [A, B],
      status: { a: 'error', b: 'ok' },
      events: [makeEvent({ id: 'e2', sourceId: 'b', summary: 'Beta Event' })],
    });
    expect(() => render(<CalendarPane {...paneProps({ sources: [A, B], controller })} />)).not.toThrow();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load calendar events/i);
    expect(screen.getByText('Beta Event')).toBeInTheDocument();
  });

  it('an errored sole source with no events renders the error notice, not the empty state', () => {
    const controller = createFakeController({ sources: [A], status: { a: 'error' } });
    render(<CalendarPane {...paneProps({ sources: [A], controller })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load calendar events/i);
    expect(screen.queryByText(/no matching events in the next 30 days/i)).not.toBeInTheDocument();
  });
});
