import { afterEach, expect, it, vi } from 'vitest';
import { commands, page, userEvent } from '@vitest/browser/context';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarPane } from '../CalendarPane.js';
import { CalendarSelector } from '../CalendarSelector.js';
import { baseProps, createFakeController, makeEvent, SOURCE } from './helpers.js';
import '../styles.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

declare module '@vitest/browser/context' {
  interface BrowserCommands { containmentViewport(width: number, height: number): Promise<void> }
}

let root: Root;
let host: HTMLDivElement;
const frame = () => new Promise(resolve => setTimeout(resolve, 100));
afterEach(async () => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
  await page.viewport(1000, 900);
  await commands.containmentViewport(1000, 900);
});

function el(selector: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}
const rect = (selector: string) => el(selector).getBoundingClientRect();
const click = async (element: HTMLElement) => act(() => userEvent.click(element));
const key = async (value: string) => act(() => userEvent.keyboard(value));

const calendars = Array.from({ length: 20 }, (_, i) => ({
  id: `c${i}`, summary: `Calendar ${i} — long descriptive team calendar name`, primary: i === 0,
}));

function fixtureProps(grouped = true) {
  const events = Array.from({ length: 20 }, (_, i) => makeEvent({
    id: `e${i}`, calendarId: 'c0',
    start: { dateTime: new Date(2026, 9, 27, 0, i * 30).toISOString() },
    end: { dateTime: new Date(2026, 9, 27, 0, i * 30 + 20).toISOString() },
  }));
  const props = baseProps({ events, calendars, selectedCalendarIds: ['c0'] });
  const sources = grouped ? [SOURCE, { id: 's2', email: 'second-long-account@example.com' }] : [SOURCE];
  return { ...props, sources, controller: createFakeController({
    sources, events,
    calendars: Object.fromEntries(sources.map(source => [source.id, calendars])),
    selected: Object.fromEntries(sources.map(source => [source.id, ['c0']])),
  }) };
}

async function mountPane(width: number, height: number, grouped = true) {
  // page.viewport only sizes Vitest's tester iframe. Leave room in the outer
  // Playwright viewport for that iframe and the runner chrome as well.
  await commands.containmentViewport(1600, 1100);
  await page.viewport(1448, 900);
  vi.setSystemTime(new Date(2026, 9, 27, 12));
  host = document.createElement('div');
  // Definite-height flex host matches the working deployed column. This does not
  // prescribe a generic block-host fill rule or reproduce a missing footer.
  host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;display:flex;flex-direction:column;overflow:hidden;font:16px Arial`;
  document.body.append(host);
  root = createRoot(host);
  const props = fixtureProps(grouped);
  act(() => root.render(<CalendarPane {...props} theme="light" />));
  await frame();
  return props;
}

function evidence(label: string) {
  const geometry = Object.fromEntries([
    '.calendar-pane', '.calendar-pane-footer', '[role=combobox]',
    '.calendar-selector-dropdown', '[role=searchbox]', '[role=listbox]',
  ].map(selector => [selector, rect(selector).toJSON()]));
  const message = `${label}: ${JSON.stringify(geometry)}`;
  console.info(message);
  return message;
}

function hit(element: HTMLElement, label: string) {
  const r = element.getBoundingClientRect();
  expect.soft(r.width, `${label} width`).toBeGreaterThan(0);
  expect.soft(r.height, `${label} height`).toBeGreaterThan(0);
  const target = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  expect.soft(target !== null && element.contains(target), `${label} center is hit-testable: ${JSON.stringify(r.toJSON())}`).toBe(true);
}

function paneBounds(label: string, aligned = false) {
  const message = evidence(label);
  const pane = rect('.calendar-pane');
  const popup = rect('.calendar-selector-dropdown');
  const trigger = rect('[role=combobox]');
  const ribbon = rect('.calendar-day-ribbon');
  expect.soft(popup.top, `${message} popup top`).toBeGreaterThanOrEqual(pane.top);
  expect.soft(popup.bottom, `${message} popup bottom`).toBeLessThanOrEqual(pane.bottom);
  expect.soft(trigger.top - popup.bottom, `${label} trigger gap`).toBeCloseTo(6);
  expect.soft(popup.left, `${message} footer/ribbon inset`).toBeGreaterThanOrEqual(Math.max(pane.left + 16, ribbon.right));
  expect.soft(popup.right, `${message} right inset`).toBeLessThanOrEqual(pane.right - 16);
  if (aligned) expect.soft(popup.left, `${message} trigger-aligned left edge`).toBeCloseTo(trigger.left);
}

it('selector containment: wide popup opens beside its left trigger at 1448px', async () => {
  const props = await mountPane(1448, 800);
  await click(el('[role=combobox]'));
  await frame();
  paneBounds('wide 1448x800', true);
  hit(el('[role=searchbox]'), 'wide search');
  expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
});

it.each([340, 240])('selector containment: popup respects pane and ribbon insets at %ipx', async width => {
  const props = await mountPane(width, 800);
  await click(el('[role=combobox]'));
  await frame();
  paneBounds(`narrow ${width}x800`);
  hit(el('[role=searchbox]'), 'narrow search');
  hit(el('.calendar-selector-dropdown > .calendar-selector-actions button'), 'narrow Done');
  expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
});

it.each([true, false])('selector containment: short wide popup controls and options remain reachable (grouped=%s)', async grouped => {
  const props = await mountPane(1448, 320, grouped);
  await click(el('[role=combobox]'));
  await frame();
  paneBounds(`short 1448x320 grouped=${grouped}`);
  const search = el('[role=searchbox]');
  const done = Array.from(host.querySelectorAll<HTMLElement>('.calendar-selector-dropdown > .calendar-selector-actions button'))
    .find(button => button.textContent === 'Done')!;
  hit(search, 'short search');
  hit(done, 'short Done');
  // Opening focuses search even on the broken layout; native keyboard input
  // exercises filtering without Playwright scrolling the clipped popup for us.
  expect(document.activeElement).toBe(search);
  await key('no-matching-calendar');
  expect(host.querySelectorAll('[role=option]')).toHaveLength(0);
  expect(el('[role=listbox]').textContent).toContain('No calendars found');
  act(() => (search as HTMLInputElement).select());
  await key('{Backspace}');
  const list = el('[role=listbox]');
  expect(host.querySelectorAll('[role=option]')).toHaveLength(grouped ? 40 : 20);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  // Each account's actions must be reachable through the options scroller.
  for (const button of list.querySelectorAll<HTMLElement>('.calendar-selector-actions button')) {
    list.scrollTop += button.getBoundingClientRect().top - list.getBoundingClientRect().top - 4;
    await frame();
    hit(button, `account ${button.textContent}`);
  }
  list.scrollTop = list.scrollHeight;
  await frame();
  expect(list.scrollTop).toBeGreaterThan(0);
  const last = Array.from(list.querySelectorAll<HTMLElement>('[role=option]')).at(-1)!;
  hit(last, 'last calendar option');
  expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
  await click(last);
  expect(props.controller.setSelectedIds).toHaveBeenLastCalledWith(grouped ? 's2' : 's1', ['c0', 'c19']);
  // Keep native Tab reachability, then use the supported pointer Done action.
  // Its bottom edge remains exposed on the initial broken layout; the center
  // hit-test above must still fail until full-popup containment is implemented.
  act(() => search.focus());
  const actionCount = grouped ? 1 : 3;
  for (let i = 0; i < actionCount; i++) await act(() => userEvent.tab());
  expect(document.activeElement).toBe(done);
  await act(() => userEvent.click(done, {
    position: { x: done.clientWidth / 2, y: done.clientHeight - 1 },
  }));
  expect(host.querySelector('.calendar-selector-dropdown')).toBeNull();
  expect(document.activeElement).toBe(el('[role=combobox]'));
});

it('selector containment: resizing an open popup retains query and updates pane bounds', async () => {
  const props = await mountPane(340, 800);
  await click(el('[role=combobox]'));
  await key('Calendar');
  const popup = el('.calendar-selector-dropdown');
  for (const [width, height] of [[1448, 320], [240, 400], [340, 320]]) {
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    await frame();
    expect(el('.calendar-selector-dropdown')).toBe(popup);
    expect((el('[role=searchbox]') as HTMLInputElement).value).toBe('Calendar');
    expect(el('[role=combobox]').getAttribute('aria-expanded')).toBe('true');
    paneBounds(`resized ${width}x${height}`, width === 1448);
  }
  expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
  await key('{Escape}');
  expect(document.activeElement).toBe(el('[role=combobox]'));
});

it('selector containment: standalone placement and scrolling are isolated from pane constraints', async () => {
  await mountPane(240, 320);
  const onChange = vi.fn();
  act(() => root.render(<>
    <CalendarPane {...fixtureProps()} />
    <section style={{ position: 'fixed', left: 500, top: 500, width: 360 }}>
      <CalendarSelector calendars={calendars} selectedIds={['c0']} onChange={onChange} theme="light" />
    </section>
  </>));
  const trigger = el('section [role=combobox]');
  await click(trigger);
  await frame();
  const popup = rect('section .calendar-selector-dropdown');
  expect(popup.width).toBeGreaterThanOrEqual(220);
  expect(popup.width).toBeLessThanOrEqual(320);
  expect(popup.right).toBeCloseTo(rect('section').right);
  expect(trigger.getBoundingClientRect().top - popup.bottom).toBeCloseTo(6);
  expect(popup.left).toBeGreaterThan(rect('.calendar-pane').right);
  expect(rect('section [role=listbox]').height).toBe(240);
  hit(el('section [role=searchbox]'), 'standalone search');
  host.style.width = '340px';
  await frame();
  expect(rect('section .calendar-selector-dropdown').toJSON()).toEqual(popup.toJSON());
  expect(onChange).not.toHaveBeenCalled();
  await key('{Escape}');
  expect(document.activeElement).toBe(trigger);
});
