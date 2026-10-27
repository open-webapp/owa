import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarPane } from '../CalendarPane.js';
import { baseProps, makeEvent } from './helpers.js';
import '../styles.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

const frame = () => new Promise((r) => setTimeout(r, 100));

function mount() {
  host = document.createElement('div');
  host.style.cssText = 'width:360px;height:400px;display:flex;flex-direction:column;font:16px Arial';
  document.body.append(host);
  root = createRoot(host);
  const events = Array.from({ length: 12 }, (_, i) => makeEvent({
    id: `e${i}`,
    start: { dateTime: `2026-10-27T${String(8 + i).padStart(2, '0')}:00:00Z` },
    end: { dateTime: `2026-10-27T${String(8 + i).padStart(2, '0')}:30:00Z` },
  }));
  act(() => root.render(<CalendarPane {...baseProps({ events })} />));
}
const q = (s: string) => host.querySelector<HTMLElement>(s)!;
const center = (e: Element) => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; };

const headers = () => q('.calendar-pane-scroll > .calendar-rsvp-chips, .calendar-rsvp-chips').getBoundingClientRect().height
  + q('.calendar-day-header').getBoundingClientRect().height;

// The visible slice of the ribbon: below the sticky headers, inside the scroll area.
function visibleCenter() {
  const r = q('.calendar-day-ribbon').getBoundingClientRect();
  const s = q('.calendar-pane-scroll').getBoundingClientRect();
  const top = Math.max(r.top, s.top + headers());
  const bottom = Math.min(r.bottom, s.bottom);
  return (top + bottom) / 2;
}

it.each([0, 100, 250])('centers the date label in the visible part of the ribbon (scrollTop=%i)', async (scrollTop) => {
  mount();
  await frame();
  expect(q('.calendar-day-ribbon').getBoundingClientRect().height).toBeGreaterThan(300);
  q('.calendar-pane-scroll').scrollTop = scrollTop;
  expect(Math.abs(center(q('.calendar-day-ribbon-label')) - visibleCenter())).toBeLessThan(2);
});

it('centers the label in a short day ribbon', async () => {
  mount();
  await frame();
  act(() => root.render(<CalendarPane {...baseProps({ events: [makeEvent({ id: 'x', start: { dateTime: '2026-10-27T10:00:00Z' }, end: { dateTime: '2026-10-27T10:30:00Z' } })] })} />));
  expect(Math.abs(center(q('.calendar-day-ribbon-label')) - center(q('.calendar-day-ribbon')))).toBeLessThan(2);
});
