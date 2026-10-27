import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarPane } from '../CalendarPane.js';
import { baseProps, makeEvent } from './helpers.js';
import '../styles.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });

const frame = () => new Promise((r) => setTimeout(r, 100));

function mount(theme: 'light' | 'dark' = 'light') {
  host = document.createElement('div');
  host.style.cssText = 'width:360px;height:400px;display:flex;flex-direction:column;font:16px Arial';
  document.body.append(host);
  root = createRoot(host);
  const events = Array.from({ length: 12 }, (_, i) => makeEvent({
    id: `e${i}`,
    // Earlier local hours keep all serialized instants on Oct 27 in this browser timezone.
    start: { dateTime: new Date(2026, 9, 27, 4 + i).toISOString() },
    end: { dateTime: new Date(2026, 9, 27, 4 + i, 30).toISOString() },
  }));
  console.info(`Ribbon fixture: ${JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, first: events[0].start, last: events[11].end })}`);
  const props = baseProps({ events });
  act(() => root.render(<CalendarPane {...props} theme={theme} />));
  return props;
}
const q = (s: string) => host.querySelector<HTMLElement>(s)!;
const center = (e: Element) => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; };

const headers = () => q('.calendar-pane-scroll > .calendar-rsvp-chips, .calendar-rsvp-chips').getBoundingClientRect().height
  + q('.calendar-day-header').getBoundingClientRect().height;

// The visible slice of the ribbon: below the sticky headers, inside the scroll area.
function visibleSlice() {
  const r = q('.calendar-day-ribbon').getBoundingClientRect();
  const s = q('.calendar-pane-scroll').getBoundingClientRect();
  const top = Math.max(r.top, s.top + headers());
  const bottom = Math.min(r.bottom, s.bottom);
  return { top, bottom, center: (top + bottom) / 2 };
}

async function expectVisibleCenter(scrollTop: number) {
  expect(q('.calendar-day-ribbon').getBoundingClientRect().height).toBeGreaterThan(300);
  q('.calendar-pane-scroll').scrollTop = scrollTop;
  await frame();
  expect(q('.calendar-pane-scroll').scrollTop).toBe(scrollTop);
  const slice = visibleSlice();
  expect(slice.bottom).toBeGreaterThan(slice.top);
  const labelCenter = center(q('.calendar-day-ribbon-label'));
  const bounds = Object.fromEntries([
    '.calendar-pane-scroll', '.calendar-rsvp-chips', '.calendar-day-ribbon',
    '.calendar-day-ribbon-window', '.calendar-day-ribbon-label',
  ].map((selector) => [selector, q(selector).getBoundingClientRect().toJSON()]));
  const dayHeaders = Array.from(host.querySelectorAll('.calendar-day-header'))
    .map((header) => header.getBoundingClientRect().toJSON());
  const evidence = JSON.stringify({ scrollTop, slice, labelCenter, bounds, dayHeaders });
  console.info(`Ribbon geometry: ${evidence}`);
  expect(Math.abs(labelCenter - slice.center), evidence).toBeLessThan(2);
}

it.each([0, 100, 250])('centers the date label after empty Today (scrollTop=%i)', async (scrollTop) => {
  vi.setSystemTime(new Date(2026, 9, 26, 12));
  mount();
  await frame();
  const groups = host.querySelectorAll('.calendar-day-group');
  expect(host.querySelectorAll('.calendar-day-header')).toHaveLength(2);
  expect(groups).toHaveLength(2);
  expect(groups[0].querySelector('.calendar-day-header')?.textContent).toBe('Today · Oct 26');
  expect(groups[0].querySelectorAll('.calendar-event-row')).toHaveLength(0);
  expect(groups[0].querySelector('.calendar-day-ribbon')).toBeNull();
  expect(groups[1].querySelector('.calendar-day-header')?.textContent).toBe('Tomorrow · Oct 27');
  expect(groups[1].querySelector('.calendar-day-ribbon')).not.toBeNull();
  expect(groups[1].querySelectorAll('.calendar-event-row')).toHaveLength(12);
  await expectVisibleCenter(scrollTop);
});

it.each([0, 100, 250])('centers the date label without an extra day header (scrollTop=%i)', async (scrollTop) => {
  vi.setSystemTime(new Date(2026, 9, 27, 12));
  mount();
  await frame();
  expect(host.querySelectorAll('.calendar-day-header')).toHaveLength(1);
  expect(host.querySelectorAll('.calendar-day-group')).toHaveLength(1);
  expect(q('.calendar-day-header').textContent).toBe('Today · Oct 27');
  expect(host.querySelectorAll('.calendar-day-ribbon')).toHaveLength(1);
  expect(host.querySelectorAll('.calendar-event-row')).toHaveLength(12);
  await expectVisibleCenter(scrollTop);
});

it('centers the label in a short day ribbon', async () => {
  vi.setSystemTime(new Date(2026, 9, 27, 12));
  mount();
  await frame();
  act(() => root.render(<CalendarPane {...baseProps({ events: [makeEvent({ id: 'x', start: { dateTime: new Date(2026, 9, 27, 10).toISOString() }, end: { dateTime: new Date(2026, 9, 27, 10, 30).toISOString() } })] })} />));
  await frame();
  expect(host.querySelectorAll('.calendar-day-header')).toHaveLength(1);
  expect(Math.abs(center(q('.calendar-day-ribbon-label')) - center(q('.calendar-day-ribbon')))).toBeLessThan(2);
});

it('updates the visible slice after host resize and a mounted theme change', async () => {
  vi.setSystemTime(new Date(2026, 9, 26, 12));
  const props = mount();
  await frame();
  await expectVisibleCenter(0);
  host.style.height = '320px';
  await frame();
  expect(q('.calendar-pane-scroll').getBoundingClientRect().height).toBe(320);
  await expectVisibleCenter(0);
  act(() => root.render(<CalendarPane {...props} theme="dark" />));
  await frame();
  expect(q('.calendar-pane').dataset.calendarTheme).toBe('dark');
  await expectVisibleCenter(0);
  await expectVisibleCenter(100);
});
