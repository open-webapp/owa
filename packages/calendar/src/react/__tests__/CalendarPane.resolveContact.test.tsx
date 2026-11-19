import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import type { Source } from '../../core/types.js';
import { createFakeController, makeEvent, type RsvpSelection } from './helpers.js';

const A: Source = { id: 'a', email: 'a@example.com' };
const B: Source = { id: 'b', email: 'b@example.com' };
const DEFAULT: RsvpSelection = new Set(['accepted', 'tentative', 'needsAction']);
const resolve = (e: string) => (e === 'o@x.com' ? { name: 'Olive Oyl', photoUrl: 'https://img.example/o.png' } : undefined);

function pane(sources: Source[], events: ReturnType<typeof makeEvent>[], rc?: typeof resolve) {
  const controller = createFakeController({ sources, events });
  return render(
    <CalendarPane sources={sources} controller={controller} selectedRsvpStatuses={DEFAULT} onRsvpStatusesChange={vi.fn()} resolveContact={rc} />,
  );
}
const org = { displayName: 'Olive', email: 'o@x.com', self: false };

describe('CalendarPane list-row organizer resolveContact', () => {
  beforeEach(() => {
    vi.stubGlobal('open', vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('list row shows the contact name and never an avatar', () => {
    const { container } = pane([A], [makeEvent({ id: 'e1', sourceId: 'a', summary: 'Alpha', organizer: org })], resolve);
    const row = screen.getByText('Alpha').closest('.calendar-event-row')!;
    expect(row).toHaveTextContent('Olive Oyl');
    expect(row).not.toHaveTextContent(/Olive(?! Oyl)/);
    expect(container.querySelector('.calendar-event-row img')).toBeNull();
  });

  it('multi-source keeps the account email suffix', () => {
    pane([A, B], [makeEvent({ id: 'e1', sourceId: 'a', summary: 'Alpha', organizer: org })], resolve);
    expect(screen.getByText('Alpha').closest('.calendar-event-row')).toHaveTextContent('Olive Oyl · a@example.com');
  });

  it('self organizer with nothing resolved stays "You"', () => {
    pane([A], [makeEvent({ id: 'e1', sourceId: 'a', summary: 'Alpha', organizer: { self: true } })], resolve);
    expect(screen.getByText('Alpha').closest('.calendar-event-row')).toHaveTextContent('You');
  });

  it('list row and overlay show the same name', () => {
    pane([A], [makeEvent({ id: 'e1', sourceId: 'a', summary: 'Alpha', organizer: org })], resolve);
    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.getAllByText('Olive Oyl').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Olive')).toBeNull();
  });

  it('absent resolver keeps displayName', () => {
    pane([A], [makeEvent({ id: 'e1', sourceId: 'a', summary: 'Alpha', organizer: org })]);
    expect(screen.getByText('Alpha').closest('.calendar-event-row')).toHaveTextContent('Olive');
  });
});
