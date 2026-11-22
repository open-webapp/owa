import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WeekStrip } from '../WeekStrip';
import '../styles.css';

let host: HTMLDivElement;
let root: Root;
function mount(selected = '2026-11-21') {
  host = document.createElement('div');
  host.className = 'calendar-pane';
  host.style.width = '400px';
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<WeekStrip today={new Date(2026, 10, 21)} selected={selected} eventDays={new Set()} loading={false} onSelect={() => {}} />));
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
const handle = () => host.querySelector<HTMLButtonElement>('.calendar-weekstrip-handle')!;
const viewport = () => host.querySelector<HTMLElement>('.calendar-weekstrip-weeks')!;
function click() { act(() => handle().click()); }
function pointer(type: string, y: number) {
  act(() => { handle().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientY: y })); });
}

it('defaults collapsed on each mount and toggles by click, Enter and Space', () => {
  mount();
  expect(handle()?.getAttribute('aria-expanded')).toBe('false');
  click();
  expect(handle().getAttribute('aria-expanded')).toBe('true');
  for (const key of ['Enter', ' ']) {
    act(() => { handle().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    expect(handle().getAttribute('aria-expanded')).toBe(key === 'Enter' ? 'false' : 'true');
  }
  act(() => root.unmount()); host.remove();
  mount();
  expect(handle().getAttribute('aria-expanded')).toBe('false');
});

it('uses directional drags of at least 24px, ignores 10px and cancels pointers', () => {
  mount();
  pointer('pointerdown', 100); pointer('pointerup', 110);
  expect(handle().getAttribute('aria-expanded')).toBe('false');
  pointer('pointerdown', 100); pointer('pointerup', 130);
  expect(handle().getAttribute('aria-expanded')).toBe('true');
  // The browser click following a drag must not reverse the expansion.
  click();
  expect(handle().getAttribute('aria-expanded')).toBe('true');
  pointer('pointerdown', 100); pointer('pointercancel', 70); pointer('pointerup', 70);
  expect(handle().getAttribute('aria-expanded')).toBe('true');
  pointer('pointerdown', 100); pointer('pointerup', 70);
  expect(handle().getAttribute('aria-expanded')).toBe('false');
});

it('starts at the current week and collapses back to it after scrolling', () => {
  mount('2026-12-10');
  click();
  expect(viewport().scrollTop).toBe(0);
  expect(viewport().querySelector('[role="row"]')?.getAttribute('aria-label')).toBe('Week of 2026-11-15');
  act(() => { viewport().scrollTop = 440; viewport().dispatchEvent(new Event('scroll')); });
  click();
  expect(viewport().scrollTop).toBe(0);
  expect(viewport().querySelector('[role="row"]')?.getAttribute('aria-label')).toBe('Week of 2026-11-15');
  expect(viewport().querySelectorAll('[role="row"]')).toHaveLength(1);
});

it.runIf(!navigator.userAgent.toLowerCase().includes('jsdom'))('browser layout: six visible rows, later weeks and stable prepend', async () => {
  mount(); click();
  const weeks = viewport();
  const first = weeks.querySelector<HTMLElement>('[role="row"]')!;
  const rowHeight = first.getBoundingClientRect().height;
  expect(rowHeight).toBeGreaterThan(0);
  expect(weeks.clientHeight).toBe(rowHeight * 6);
  expect(getComputedStyle(weeks).overflowY).toBe('auto');
  expect(getComputedStyle(weeks).scrollSnapType).toBe('y mandatory');
  const initialLast = weeks.lastElementChild!.getAttribute('aria-label');
  await act(async () => { weeks.scrollTop = weeks.scrollHeight - weeks.clientHeight; weeks.dispatchEvent(new Event('scroll')); });
  expect(weeks.lastElementChild!.getAttribute('aria-label')).not.toBe(initialLast);
  expect(weeks.querySelector('[aria-label="Week of 2027-02-07"]')).not.toBeNull();
  await act(async () => { weeks.scrollTop = 0; weeks.dispatchEvent(new Event('scroll')); });
  expect(weeks.firstElementChild!.getAttribute('aria-label')).toBe('Week of 2026-08-23');
  expect(Math.abs(first.getBoundingClientRect().top - weeks.getBoundingClientRect().top)).toBeLessThan(1);
  expect(weeks.scrollTop).toBe(rowHeight * 12);
});
