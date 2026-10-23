import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import type { Source } from '../../core/types.js';
import { createFakeController, makeEvent, SOURCE, type RsvpSelection } from './helpers.js';

const DEFAULT: RsvpSelection = new Set(['accepted', 'tentative', 'needsAction']);
const base = { selectedRsvpStatuses: DEFAULT, onRsvpStatusesChange: vi.fn() };
// Pane props not yet in the package types (connected/onConnect/onReconnect).
const paneProps = (o: Record<string, unknown>) => ({ ...base, ...o }) as any;

describe('CalendarPane status UI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('shows built-in connect prompt when not connected, and calls onConnect', () => {
    const onConnect = vi.fn();
    const controller = createFakeController({ sources: [SOURCE] });
    render(<CalendarPane {...paneProps({ sources: [SOURCE], controller, connected: false, onConnect })} />);
    expect(screen.getByText('Not connected to Google Calendar.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Calendar' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('shows built-in reconnect prompt when needsReauth, and calls onReconnect', () => {
    const onReconnect = vi.fn();
    const controller = createFakeController({ sources: [SOURCE], status: { s1: 'needs-scope' } });
    render(<CalendarPane {...paneProps({ sources: [SOURCE], controller, needsReauth: true, onReconnect })} />);
    expect(screen.getByText('Calendar connection needs reauthorization.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect to restore sync' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('shows loading text when controller is loading with no events', () => {
    const controller = createFakeController({ sources: [SOURCE], state: { loading: true } });
    render(<CalendarPane {...paneProps({ sources: [SOURCE], controller })} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load calendar events. Try again shortly.")).toBeNull();
  });

  it('shows error and no day groups when controller errored with nothing cached', () => {
    const controller = createFakeController({ sources: [SOURCE], state: { error: true } });
    render(<CalendarPane {...paneProps({ sources: [SOURCE], controller })} />);
    expect(screen.getByText("Couldn't load calendar events. Try again shortly.")).toBeInTheDocument();
    expect(document.querySelector('.calendar-day-groups')).toBeNull();
  });

  it('shows cached events (no error block) when controller errored but events are cached', () => {
    const controller = createFakeController({
      sources: [SOURCE],
      events: [makeEvent({ id: 'c1', summary: 'Cached standup' })],
      state: { error: true },
    });
    render(<CalendarPane {...paneProps({ sources: [SOURCE], controller })} />);
    expect(screen.getByText('Cached standup')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load calendar events. Try again shortly.")).toBeNull();
  });

  it('shows empty text when connected, idle and no events', () => {
    const controller = createFakeController({ sources: [SOURCE] });
    render(<CalendarPane {...paneProps({ sources: [SOURCE], controller })} />);
    expect(screen.getByText('No matching events in the next 30 days')).toBeInTheDocument();
  });

  it('behaves as connected when no connected prop is given', () => {
    const controller = createFakeController({ sources: [SOURCE], events: [makeEvent({ summary: 'Planning' })] });
    render(<CalendarPane {...paneProps({ sources: [SOURCE], controller })} />);
    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.queryByText('Not connected to Google Calendar.')).toBeNull();
  });

  it('emptyState slot overrides built-in connect prompt', () => {
    const controller = createFakeController({ sources: [] });
    render(<CalendarPane {...paneProps({ sources: [], controller, emptyState: <p>Custom connect</p>, onConnect: vi.fn() })} />);
    expect(screen.getByText('Custom connect')).toBeInTheDocument();
    expect(screen.queryByText('Not connected to Google Calendar.')).toBeNull();
  });

  it('sourceNotice slot overrides built-in reconnect copy', () => {
    const controller = createFakeController({ sources: [SOURCE], status: { s1: 'needs-scope' } });
    render(
      <CalendarPane
        {...paneProps({ sources: [SOURCE], controller, onReconnect: vi.fn(), sourceNotice: (s: Source) => <p>Grant {s.email}</p> })}
      />,
    );
    expect(screen.getByText('Grant me@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Calendar connection needs reauthorization.')).toBeNull();
  });

  it('multi-source needs-scope: notice only for the affected source, events still render', () => {
    const A: Source = { id: 'a', email: 'a@example.com' };
    const B: Source = { id: 'b', email: 'b@example.com' };
    const controller = createFakeController({
      sources: [A, B],
      status: { a: 'needs-scope', b: 'ok' },
      events: [makeEvent({ id: 'b1', sourceId: 'b', summary: 'B meeting' })],
    });
    const sourceNotice = vi.fn((s: Source) => <p>Reconnect {s.email}</p>);
    render(<CalendarPane {...paneProps({ sources: [A, B], controller, sourceNotice })} />);
    expect(screen.getByText('Reconnect a@example.com')).toBeInTheDocument();
    expect(screen.getByText('B meeting')).toBeInTheDocument();
  });
});
