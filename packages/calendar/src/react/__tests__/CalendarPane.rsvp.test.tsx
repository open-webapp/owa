import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import type { CalendarEvent } from '../../core/types.js';
import { makeEvent, baseProps } from './helpers.js';

const att = (o: Record<string, unknown>) => ({ email: 'x@x.com', responseStatus: 'needsAction', ...o }) as never;
function inviteEvent(over: Partial<CalendarEvent> = {}) {
  return makeEvent({
    id: 'a',
    summary: 'Alpha',
    selfResponseStatus: 'accepted',
    attendees: [att({ email: 'me@x.com', self: true, responseStatus: 'accepted' }), att({ email: 'b@x.com', responseStatus: 'accepted' })],
    ...over,
  });
}
const radio = (n: string) => screen.getByRole('radio', { name: n });
const card = () => document.querySelector('.calendar-event-header .calendar-event-rsvp') as HTMLElement | null;
const open = () => fireEvent.click(screen.getByRole('link', { name: 'Alpha' }));
const flush = () => act(async () => {});

function setup(events: CalendarEvent[], handler?: (e: CalendarEvent, s: string) => Promise<void>, extra: Record<string, unknown> = {}) {
  const props = baseProps({ events });
  const ctl = props.controller;
  let evs = events;
  ctl.getEvents = () => evs;
  const utils = render(<CalendarPane {...props} {...extra} {...(handler ? { onRsvpChange: handler as never } : {})} />);
  return { ...utils, props, setEvents(n: CalendarEvent[]) { evs = n; act(() => { (ctl.subscribe as never as (l: () => void) => void)(() => {}); }); } };
}

describe('CalendarPane RSVP change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('optimistically updates overlay and card; handler gets event+status', async () => {
    const e = inviteEvent({ selfResponseStatus: 'tentative' });
    const h = vi.fn(() => new Promise<void>(() => {}));
    setup([e], h);
    open();
    fireEvent.click(radio('Yes'));
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'accepted');
    expect(radio('Yes')).toHaveAttribute('aria-checked', 'true');
    expect(card()).toHaveAttribute('aria-label', 'accepted');
  });

  it('disables buttons while pending, and ignores second click; re-enables on resolve', async () => {
    let res!: () => void;
    const h = vi.fn(() => new Promise<void>((r) => { res = r; }));
    setup([inviteEvent()], h);
    open();
    fireEvent.click(radio('No'));
    expect(radio('Yes')).toBeDisabled();
    fireEvent.click(radio('Maybe'));
    expect(h).toHaveBeenCalledTimes(1);
    res();
    await flush();
    expect(radio('Yes')).not.toBeDisabled();
    expect(radio('No')).toHaveAttribute('aria-checked', 'true');
  });

  it('rolls back and shows error on reject; Retry works', async () => {
    const h = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    setup([inviteEvent()], h);
    open();
    fireEvent.click(radio('No'));
    await flush();
    expect(radio('Yes')).toHaveAttribute('aria-checked', 'true');
    expect(card()).toHaveAttribute('aria-label', 'accepted');
    expect(screen.getByText("Couldn't update RSVP.")).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(h).toHaveBeenCalledTimes(2);
    expect(radio('No')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps overlay open and card in list when change hides it from filter; card drops after close', async () => {
    const e = inviteEvent({ selfResponseStatus: 'needsAction' });
    setup([e], vi.fn().mockResolvedValue(undefined), { selectedRsvpStatuses: new Set(['needsAction']) });
    open();
    fireEvent.click(radio('Yes'));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('link', { name: 'Alpha' })).not.toBeInTheDocument();
  });

  it('no radio checked when self is needsAction', () => {
    setup([inviteEvent({ selfResponseStatus: 'needsAction' })], vi.fn().mockResolvedValue(undefined), { selectedRsvpStatuses: new Set(['needsAction']) });
    open();
    for (const n of ['Yes', 'Maybe', 'No']) expect(radio(n)).toHaveAttribute('aria-checked', 'false');
  });

  it('prop absent, or not invited, or no attendees: no RSVP row', () => {
    const { unmount } = setup([inviteEvent()]);
    open();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    unmount();
    const h = vi.fn();
    const r1 = setup([inviteEvent({ attendees: [att({ email: 'b@x.com' }), att({ email: 'c@x.com' })] })], h);
    open();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    r1.unmount();
    setup([inviteEvent({ attendees: undefined })], h);
    open();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('times out after 60s: rollback, error, enabled; late resolve ignored', async () => {
    let res!: () => void;
    const h = vi.fn(() => new Promise<void>((r) => { res = r; }));
    setup([inviteEvent()], h);
    open();
    fireEvent.click(radio('No'));
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(radio('Yes')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Yes')).not.toBeDisabled();
    expect(screen.getByText("Couldn't update RSVP.")).toBeVisible();
    res();
    await flush();
    expect(radio('Yes')).toHaveAttribute('aria-checked', 'true');
  });

  it('unmount while pending clears the 60s timer', async () => {
    const st = vi.spyOn(globalThis, 'setTimeout');
    const ct = vi.spyOn(globalThis, 'clearTimeout');
    const h = vi.fn(() => new Promise<void>(() => {}));
    const { unmount } = setup([inviteEvent()], h);
    open();
    fireEvent.click(radio('No'));
    const idx = st.mock.calls.findIndex((c) => c[1] === 60000);
    expect(idx).toBeGreaterThanOrEqual(0);
    const id = st.mock.results[idx].value;
    unmount();
    expect(ct).toHaveBeenCalledWith(id);
  });

  it('changing filter chips while pending closes overlay; late resolve does not throw', async () => {
    let res!: () => void;
    const h = vi.fn(() => new Promise<void>((r) => { res = r; }));
    const r = setup([inviteEvent()], h);
    open();
    fireEvent.click(radio('No'));
    r.rerender(<CalendarPane {...r.props} selectedRsvpStatuses={new Set(['accepted'])} onRsvpChange={h as never} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    res();
    await flush();
  });

  it('refresh delivering the key clears override; server status shown', async () => {
    const e = inviteEvent({ selfResponseStatus: 'tentative' });
    const h = vi.fn().mockResolvedValue(undefined);
    const props = baseProps({ events: [e] });
    let evs = [e];
    props.controller.getEvents = () => evs;
    let notify = () => {};
    props.controller.subscribe = (l) => { notify = l; return () => {}; };
    render(<CalendarPane {...props} onRsvpChange={h} />);
    open();
    fireEvent.click(radio('Yes'));
    await flush();
    expect(card()).toHaveAttribute('aria-label', 'accepted');
    evs = [{ ...e, selfResponseStatus: 'declined' }];
    act(() => notify());
    expect(radio('No')).toHaveAttribute('aria-checked', 'true');
    expect(within(document.body).getAllByRole('img', { name: 'declined' }).length).toBeGreaterThan(0);
  });
});
