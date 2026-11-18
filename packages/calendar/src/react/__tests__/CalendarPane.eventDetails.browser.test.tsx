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

async function open(theme: 'light' | 'dark', description: string, opts: { footer?: boolean; footerVar?: string; invitees?: number; rsvp?: boolean; pending?: boolean } = {}) {
  const withFooter = opts.footer !== false;
  await commands.containmentViewport(1600, 1100);
  await page.viewport(1448, 900);
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:40px;top:30px;width:360px;height:500px;display:flex;flex-direction:column;overflow:hidden;font:16px Arial';
  document.body.append(host);
  root = createRoot(host);
  const events = [makeEvent({ id: 'e1', calendarId: 'c0', summary: 'Standup', description,
    attendees: Array.from({ length: opts.invitees ?? 0 }, (_, i) => ({ email: `p${i}@x.com`, responseStatus: i === 0 ? 'accepted' : 'needsAction', self: i === 0 })) as never,
    start: { dateTime: new Date(2026, 9, 27, 10).toISOString() }, end: { dateTime: new Date(2026, 9, 27, 11).toISOString() } })];
  const calendars = [{ id: 'c0', summary: 'Cal', primary: true }];
  const props = baseProps({ events, calendars: withFooter ? calendars : [], selectedCalendarIds: withFooter ? ['c0'] : [] });
  const controller = createFakeController({ sources: [SOURCE], events, calendars: withFooter ? { s1: calendars } : {}, selected: withFooter ? { s1: ['c0'] } : {} });
  
  act(() => root.render(<CalendarPane {...props} sources={[SOURCE]} controller={controller} theme={theme} {...(opts.rsvp ? { onRsvpChange: () => (opts.pending ? new Promise<void>(() => {}) : Promise.reject(new Error('x'))) } : {})} />));
  await frame();
  const trigger = host.querySelector<HTMLElement>('.calendar-event-title-link');
  if (!trigger) throw new Error('no details trigger');
  await act(() => userEvent.click(trigger));
  await frame();
  await Promise.all(host.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  const q = (s: string) => host.querySelector<HTMLElement>(s)!;
  if (opts.footerVar) { q('.calendar-pane').style.setProperty('--calendar-footer-height', opts.footerVar); await frame(); }
  return { footer: host.querySelector<HTMLElement>('.calendar-pane-footer'), pane: q('.calendar-pane'), backdrop: q('.calendar-event-details'), sheet: q('.calendar-event-details-sheet') };
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

it('backdrop and sheet end at the footer top edge; footer is visible and hit-testable', async () => {
  const { pane, backdrop, sheet, footer } = await open('light', 'x');
  const p = pane.getBoundingClientRect(), b = backdrop.getBoundingClientRect(), f = footer!.getBoundingClientRect();
  for (const k of ['top', 'left', 'right'] as const) expect(b[k]).toBeCloseTo(p[k], 0);
  expect(b.bottom).toBeLessThanOrEqual(f.top + 0.5);
  expect(sheet.getBoundingClientRect().bottom).toBeLessThanOrEqual(f.top + 0.5);
  expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(p.height - 64 + 0.5);
  expect(getComputedStyle(backdrop).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(f.height).toBeGreaterThan(0);
  const hit = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2);
  expect(footer!.contains(hit)).toBe(true);
});

it('footer height override follows --calendar-footer-height', async () => {
  const { backdrop, footer, pane } = await open('light', 'x', { footerVar: '96px' });
  void footer;
  expect(pane.getBoundingClientRect().bottom - backdrop.getBoundingClientRect().bottom).toBeCloseTo(96, 0);
});

it('without a footer the backdrop fills the pane', async () => {
  const { pane, backdrop, footer } = await open('light', 'x', { footer: false });
  expect(footer).toBeNull();
  expect(backdrop.getBoundingClientRect().bottom).toBeCloseTo(pane.getBoundingClientRect().bottom, 0);
});

it('very long content scrolls inside the sheet and never reaches the footer', async () => {
  const { sheet, footer } = await open('light', Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n'));
  expect(sheet.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer!.getBoundingClientRect().top + 0.5);
  expect(sheet.scrollHeight).toBeGreaterThan(sheet.clientHeight);
});

it('footer is not dimmed by the overlay', async () => {
  const { footer } = await open('light', 'x');
  const el = footer!;
  const before = getComputedStyle(el).backgroundColor;
  expect(before).toBe('rgb(255, 255, 255)');
  expect(getComputedStyle(el).opacity).toBe('1');
});

it('sheet background follows the theme', async () => {
  const light = getComputedStyle((await open('light', 'x')).sheet).backgroundColor;
  act(() => root.unmount()); host.remove();
  const dark = getComputedStyle((await open('dark', 'x')).sheet).backgroundColor;
  expect(light).toBe('rgb(255, 255, 255)');
  expect(dark).toBe('rgb(26, 26, 26)');
});

it('sheet stays within 80% of the area above the footer with invitees + RSVP row', async () => {
  const { sheet, backdrop } = await open('light', 'x', { invitees: 12, rsvp: true });
  expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(backdrop.getBoundingClientRect().height * 0.8 + 0.5);
  expect(sheet.querySelector('[role="radiogroup"]')).not.toBeNull();
});

it('40 invitees expanded: sheet bounded and scrolls', async () => {
  const { sheet, backdrop } = await open('light', 'x', { invitees: 40, rsvp: true });
  const btn = sheet.querySelector<HTMLElement>('button[aria-expanded]')!;
  await act(() => userEvent.click(btn));
  await frame();
  expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(backdrop.getBoundingClientRect().height * 0.8 + 0.5);
  expect(sheet.scrollHeight).toBeGreaterThan(sheet.clientHeight);
});

for (const theme of ['light', 'dark'] as const) {
  it(`checked radio differs from unchecked (${theme})`, async () => {
    const { sheet } = await open(theme, 'x', { invitees: 3, rsvp: true });
    const radios = Array.from(sheet.querySelectorAll<HTMLElement>('[role="radio"]'));
    const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true')!;
    const other = radios.find((r) => r.getAttribute('aria-checked') === 'false')!;
    expect(getComputedStyle(checked).backgroundColor).not.toBe(getComputedStyle(other).backgroundColor);
  });
}

it('error text is visible after a failed RSVP', async () => {
  const { sheet } = await open('light', 'x', { invitees: 3, rsvp: true });
  const no = Array.from(sheet.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === 'No')!;
  await act(() => userEvent.click(no));
  await frame();
  const status = sheet.querySelector<HTMLElement>('.calendar-event-details-rsvp-status')!;
  expect(status.getBoundingClientRect().height).toBeGreaterThan(0);
  expect(status.textContent).toContain("Couldn't update RSVP");
});

it('pending text is visible while an RSVP is in flight', async () => {
  const { sheet } = await open('light', 'x', { invitees: 3, rsvp: true, pending: true });
  const no = Array.from(sheet.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === 'No')!;
  await act(() => userEvent.click(no));
  await frame();
  expect(sheet.querySelector<HTMLElement>('.calendar-event-details-rsvp-status')!.getBoundingClientRect().height).toBeGreaterThan(0);
});
