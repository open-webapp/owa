import { afterEach, expect, it, vi } from 'vitest';
import { commands, page, userEvent } from '@vitest/browser/context';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarPane } from '../CalendarPane.js';
import { baseProps, createFakeController, makeEvent, SOURCE } from './helpers.js';
import '../styles.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
declare module '@vitest/browser/context' {
  interface BrowserCommands { containmentViewport(w: number, h: number): Promise<void> }
}

let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });
const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function open(theme: 'light' | 'dark', description: string) {
  await commands.containmentViewport(1600, 1100);
  await page.viewport(1448, 900);
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:40px;top:30px;width:360px;height:500px;display:flex;flex-direction:column;overflow:hidden;font:16px Arial';
  document.body.append(host);
  root = createRoot(host);
  const events = [makeEvent({ id: 'e1', calendarId: 'c0', summary: 'Standup', description,
    start: { dateTime: new Date(2026, 9, 27, 10).toISOString() }, end: { dateTime: new Date(2026, 9, 27, 11).toISOString() } })];
  const calendars = [{ id: 'c0', summary: 'Cal', primary: true }];
  const props = baseProps({ events, calendars, selectedCalendarIds: ['c0'] });
  const controller = createFakeController({ sources: [SOURCE], events, calendars: { s1: calendars }, selected: { s1: ['c0'] } });
  act(() => root.render(<CalendarPane {...props} sources={[SOURCE]} controller={controller} theme={theme} />));
  await frame();
  const trigger = host.querySelector<HTMLElement>('.calendar-event-title-link');
  if (!trigger) throw new Error('no details trigger');
  await act(() => userEvent.click(trigger));
  await frame();
  await Promise.all(host.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  const q = (s: string) => host.querySelector<HTMLElement>(s)!;
  return { pane: q('.calendar-pane'), backdrop: q('.calendar-event-details'), sheet: q('.calendar-event-details-sheet') };
}

it('sheet stays inside the pane and within 80% height', async () => {
  const { pane, sheet } = await open('light', 'short');
  const p = pane.getBoundingClientRect(), s = sheet.getBoundingClientRect();
  expect(s.top).toBeGreaterThanOrEqual(p.top);
  expect(s.bottom).toBeLessThanOrEqual(p.bottom + 0.5);
  expect(s.left).toBeGreaterThanOrEqual(p.left);
  expect(s.right).toBeLessThanOrEqual(p.right);
  expect(s.height).toBeLessThanOrEqual(p.height * 0.8 + 0.5);
});

it('very long description is bounded and scrolls', async () => {
  const { pane, sheet } = await open('light', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
  expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(pane.getBoundingClientRect().height * 0.8 + 0.5);
  expect(sheet.scrollHeight).toBeGreaterThan(sheet.clientHeight);
});

it('backdrop covers the pane only', async () => {
  const { pane, backdrop } = await open('light', 'x');
  const p = pane.getBoundingClientRect(), b = backdrop.getBoundingClientRect();
  for (const k of ['top', 'left', 'right', 'bottom'] as const) expect(b[k]).toBeCloseTo(p[k], 0);
  expect(getComputedStyle(backdrop).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
});

it('sheet background follows the theme', async () => {
  const light = getComputedStyle((await open('light', 'x')).sheet).backgroundColor;
  act(() => root.unmount()); host.remove();
  const dark = getComputedStyle((await open('dark', 'x')).sheet).backgroundColor;
  expect(light).toBe('rgb(255, 255, 255)');
  expect(dark).toBe('rgb(26, 26, 26)');
});
