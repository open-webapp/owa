import { afterEach, expect, it, vi } from 'vitest';
import { commands, page, userEvent } from '@vitest/browser/context';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarPane } from '../CalendarPane.js';
import { CalendarSelector } from '../CalendarSelector.js';
import { baseProps, createFakeController, makeEvent, SOURCE, type RsvpSelection } from './helpers.js';
import '../styles.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

declare module '@vitest/browser/context' {
  interface BrowserCommands { scheme(value: 'light' | 'dark'): Promise<void> }
}

let root: Root;
let host: HTMLDivElement;
function mount(node: React.ReactNode) {
  host = document.createElement('div');
  host.style.cssText = 'width:360px;margin:400px 0 0;font:16px Arial';
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(node));
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
function el(selector: string): HTMLElement {
  const value = host.querySelector<HTMLElement>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}
function style(selector: string, values: Record<string, string>) {
  const computed = getComputedStyle(el(selector));
  for (const [property, value] of Object.entries(values)) expect(computed.getPropertyValue(property), `${selector} ${property}`).toBe(value);
}

// Literal palettes: original roles plus the T3 prototype RSVP control restyle.
// UA-native light controls were measured in pinned Chromium; no token-derived expectations.
const reference = {
  light: { surface: 'rgb(255, 255, 255)', border: 'rgb(238, 238, 238)', title: 'rgb(34, 34, 34)', header: 'rgb(245, 245, 245)', chip: 'rgb(255, 255, 255)', active: 'rgb(232, 245, 248)', dropdown: 'rgb(255, 255, 255)', text: 'rgb(26, 26, 26)', shadow: 'rgba(0, 0, 0, 0.15) 0px 4px 14px 0px' },
  dark: { surface: 'rgb(26, 26, 26)', border: 'rgb(51, 51, 51)', title: 'rgb(238, 238, 238)', header: 'rgb(34, 34, 34)', chip: 'rgb(51, 65, 85)', active: 'rgb(16, 38, 43)', dropdown: 'rgb(26, 26, 26)', text: 'rgb(238, 238, 238)', shadow: 'rgba(0, 0, 0, 0.5) 0px 4px 14px 0px' },
};
const calendars = [{ id: 'a', summary: 'Alpha', primary: true, backgroundColor: '#123456' }, { id: 'b', summary: 'Beta', backgroundColor: '#654321' }];
type Theme = 'light' | 'dark' | 'system' | undefined;
const modes = [undefined, 'system', 'light', 'dark'] as const;
const allRsvp = new Set(['accepted', 'tentative', 'needsAction', 'declined'] as const);
const rgb = (dark: boolean, light: string, night: string) => dark ? night : light;
async function click(selector: string) { await act(() => userEvent.click(el(selector))); }
async function key(value: string) { await act(() => userEvent.keyboard(value)); }
async function fill(value: string) { await act(() => userEvent.fill(el('[role=searchbox]'), value)); }

function triggerGeometry(scope: string, name: string) {
  const trigger = el(`${scope} [role=combobox]`);
  expect(trigger.getAttribute('aria-label')).toBe(name);
  const computed = getComputedStyle(trigger);
  for (const [property, value] of Object.entries({
    display: 'inline-flex', 'box-sizing': 'border-box', 'align-items': 'center',
    'justify-content': 'center', gap: '8px', 'min-height': '36px',
    padding: '8px 12px', 'border-radius': '6px', cursor: 'pointer',
    'border-width': '1px', 'border-style': 'solid',
  })) expect.soft(computed.getPropertyValue(property), `${scope} trigger ${property}`).toBe(value);
  expect.soft(computed.font, `${scope} inherited font`).toBe(getComputedStyle(trigger.parentElement!).font);
  const bounds = trigger.getBoundingClientRect();
  expect.soft(bounds.height, `${scope} rendered trigger height`).toBeGreaterThanOrEqual(36);
  const indicator = trigger.querySelector('svg');
  expect.soft(indicator, `${scope} rendered decorative chevron`).not.toBeNull();
  if (indicator) {
    expect(indicator.getAttribute('aria-hidden')).toBe('true');
    expect(indicator.getAttribute('focusable')).toBe('false');
    const icon = indicator.getBoundingClientRect();
    expect(icon.width).toBe(12);
    expect(icon.height).toBe(12);
    expect(getComputedStyle(indicator).flexShrink).toBe('0');
    expect(getComputedStyle(indicator).visibility).toBe('visible');
    expect(getComputedStyle(indicator).display).not.toBe('none');
    expect(getComputedStyle(indicator).opacity).toBe('1');
    expect(indicator.getBBox().width).toBeGreaterThan(0);
    expect(indicator.getBBox().height).toBeGreaterThan(0);
    expect(icon.left).toBeGreaterThanOrEqual(bounds.left);
    expect(icon.right).toBeLessThanOrEqual(bounds.right);
    expect(getComputedStyle(indicator).color).toBe(computed.color);
    expect(indicator.querySelector('[stroke="currentColor"], [fill="currentColor"]') ??
      (indicator.getAttribute('stroke') === 'currentColor' || indicator.getAttribute('fill') === 'currentColor' ? indicator : null)).not.toBeNull();
  }
}

for (const width of [360, 1000]) for (const single of [true, false]) {
  it(`affordance geometry and containment: ${single ? 'long name' : 'multi-account count'} at ${width}px`, async () => {
    await page.viewport(width, 900);
    const name = 'Long calendar name '.repeat(16).trim();
    const items = [{ ...calendars[0], summary: name }];
    const props = single ? baseProps({ calendars: items, selectedCalendarIds: ['a'] }) : richProps();
    const onChange = vi.fn();
    const render = (theme: Theme) => <>
      <section id="affordance-pane"><CalendarPane {...props} theme={theme} /></section>
      <section id="affordance-standalone"><CalendarSelector calendars={items} selectedIds={['a']} onChange={onChange} theme={theme} /></section>
    </>;
    mount(render('system'));
    host.style.width = width === 360 ? '328px' : '720px';
    for (const os of ['light', 'dark'] as const) for (const theme of ['light', 'dark', 'system'] as const) {
      await commands.scheme(os);
      act(() => root.render(render(theme)));
      const dark = theme === 'dark' || (theme === 'system' && os === 'dark');
      for (const scope of ['#affordance-pane', '#affordance-standalone']) {
        triggerGeometry(scope, scope === '#affordance-pane' && !single ? '3 calendars selected' : name);
        const trigger = el(`${scope} [role=combobox]`);
        const palette = getComputedStyle(trigger);
        expect.soft(palette.color, `${scope} themed text`).toBe(reference[dark ? 'dark' : 'light'].title);
        expect.soft(palette.backgroundColor, `${scope} themed surface`).toBe(reference[dark ? 'dark' : 'light'].surface);
        expect.soft(palette.borderTopColor, `${scope} control border`).toBe(dark ? 'rgb(68, 68, 68)' : 'rgb(118, 118, 118)');
        expect.soft(trigger.getBoundingClientRect().right, `${scope} trigger contained`).toBeLessThanOrEqual(host.getBoundingClientRect().right);
      }
      const footer = el('.calendar-pane-footer');
      expect.soft(footer.scrollWidth, 'no horizontal footer overflow').toBeLessThanOrEqual(footer.clientWidth);
      expect(footer.getBoundingClientRect().height).toBe(64);
      expect(onChange).not.toHaveBeenCalled();
      expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
    }
    await page.viewport(1000, 900);
  });
}

for (const theme of ['light', 'dark'] as const) for (const location of ['footer', 'standalone']) {
  it(`affordance real hover and keyboard-only focus: ${location} ${theme}`, async () => {
    await commands.scheme(theme === 'light' ? 'dark' : 'light');
    const props = richProps();
    const onChange = vi.fn();
    mount(<><button id="before">Before</button>{location === 'footer'
      ? <CalendarPane {...props} theme={theme} />
      : <CalendarSelector calendars={calendars} selectedIds={['a']} onChange={onChange} theme={theme} />}</>);
    const trigger = el('[role=combobox]');
    await userEvent.hover(el('#before'));
    const resting = getComputedStyle(trigger).backgroundColor;
    await userEvent.hover(trigger);
    expect.soft(getComputedStyle(trigger).backgroundColor, 'visible trigger hover change').not.toBe(resting);
    expect.soft(getComputedStyle(trigger).backgroundColor, 'theme hover token').toBe(theme === 'dark' ? 'rgb(42, 42, 42)' : 'rgb(240, 248, 251)');
    let pointerFocus: { visible: boolean; outline: string } | undefined;
    trigger.addEventListener('focus', () => {
      pointerFocus = { visible: trigger.matches(':focus-visible'), outline: getComputedStyle(trigger).outlineStyle };
    }, { once: true });
    await click('[role=combobox]');
    expect(pointerFocus?.visible).toBe(false);
    expect.soft(pointerFocus?.outline, 'pointer focus has no outline').toBe('none');
    expect(document.activeElement).toBe(el('[role=searchbox]'));
    await click('.calendar-selector-actions button:last-child');
    expect(document.activeElement).toBe(trigger);
    // Real pointer focus on an ordinary button must not acquire the keyboard outline.
    await click('#before');
    await click('[role=combobox]');
    await key('{Escape}');
    expect(document.activeElement).toBe(trigger);
    await click('#before');
    // RSVP controls and event links precede the footer. Bound native traversal by
    // the rendered tabbable count rather than an arbitrary number of Tab presses.
    const tabbableCount = Array.from(host.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
    )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') &&
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden').length;
    for (let i = 0; i < tabbableCount && document.activeElement !== trigger; i++) await act(() => userEvent.tab());
    expect(document.activeElement).toBe(trigger);
    expect(trigger.matches(':focus-visible')).toBe(true);
    const focus = getComputedStyle(trigger);
    expect.soft(focus.outlineStyle, 'keyboard focus outline style').toBe('solid');
    expect.soft(focus.outlineWidth, 'keyboard focus outline width').toBe('2px');
    expect.soft(focus.outlineOffset, 'keyboard focus outline offset').toBe('2px');
    expect.soft(focus.outlineColor, 'keyboard focus token').toBe(theme === 'dark' ? 'rgb(34, 208, 239)' : 'rgb(26, 115, 232)');
    for (const activation of ['{Enter}', ' ']) {
      await key(activation);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(el('[role=searchbox]'));
      expect(trigger.getAttribute('aria-controls')).toBe(el('[role=listbox]').id);
      await key('{Escape}');
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
  });
}

// The remaining literal reference roles from the original two CSS media blocks:
// light/dark prompt #555/#ccc, accent #00a9ce/#22d0ef, hover #f0f8fb/#2a2a2a,
// RSVP controls use the literal T3 prototype values asserted separately below.
// All-day #fdf6e3/#2a2510;
// current/selected #f0f8fb/#10262b; time #666, organizer/calendar #888;
// error #999; insert #888/#999, hover #222/#eee, focus #1a73e8/#22d0ef.
// RSVP bars: #2e7d32/#4ade80, #d97706/#fbbf24, #2563eb/#60a5fa,
// #dc2626/#f87171. Dots retain host/calendar colors. Copy stays literal below.
function rsvpPalette(dark: boolean, prefix = '') {
  const s = (selector: string, values: Record<string, string>) => style(prefix + selector, values);
  s('.calendar-rsvp-chip-group', {
    'background-color': rgb(dark, 'rgb(241, 245, 249)', 'rgba(30, 41, 59, 0.9)'),
    'border-color': rgb(dark, 'rgba(226, 232, 240, 0.8)', 'rgba(51, 65, 85, 0.6)'),
    'border-width': '1px', 'border-style': 'solid', 'border-radius': '12px', padding: '4px', gap: '4px',
  });
  const group = el(prefix + '.calendar-rsvp-chip-group');
  expect(group.getAttribute('role')).toBe('group');
  expect(group.getAttribute('aria-label')).toBe('RSVP Status Filters');
  expect(group.querySelectorAll('.calendar-rsvp-chip')).toHaveLength(4);
  for (const [label, color] of [
    ['Accepted', 'rgb(16, 185, 129)'], ['Maybe', 'rgb(245, 158, 11)'],
    ['Declined', 'rgb(244, 63, 94)'], ['Unaccepted', 'rgb(14, 165, 233)'],
  ]) {
    const chip = `.calendar-rsvp-chip[aria-label^="${label}"]`;
    s(chip, { color, 'border-width': '0px', 'border-style': 'none', 'border-radius': '8px', padding: '6px', height: '28px' });
    s(`${chip} svg`, { color, width: '16px', height: '16px', 'stroke-width': '2.2px' });
  }
  for (const chip of group.querySelectorAll<HTMLButtonElement>('.calendar-rsvp-chip')) {
    const selected = chip.getAttribute('aria-pressed') === 'true';
    expect(chip.classList.contains('selected')).toBe(selected);
    const computed = getComputedStyle(chip);
    expect(computed.backgroundColor).toBe(selected ? reference[dark ? 'dark' : 'light'].chip : 'rgba(0, 0, 0, 0)');
    expect(computed.boxShadow).toBe(selected ? 'rgba(99, 102, 241, 0.4) 0px 0px 0px 1px' : 'none');
  }
  s('.calendar-rsvp-chip.selected', {
    'background-color': reference[dark ? 'dark' : 'light'].chip,
    'box-shadow': 'rgba(99, 102, 241, 0.4) 0px 0px 0px 1px',
  });
  s('.calendar-rsvp-chip-badge', {
    'background-color': 'rgb(14, 165, 233)', color: 'rgb(255, 255, 255)',
    'border-color': rgb(dark, 'rgb(255, 255, 255)', 'rgb(30, 41, 59)'),
    'border-width': '1px', 'border-style': 'solid', 'font-size': '9px', 'min-width': '15px', height: '15px', top: '-4px', right: '-4px',
  });
  s('.calendar-today-btn', {
    'background-color': rgb(dark, 'rgb(241, 245, 249)', 'rgb(30, 41, 59)'),
    color: rgb(dark, 'rgb(51, 65, 85)', 'rgb(226, 232, 240)'),
    padding: '4px 8px', 'border-width': '0px', 'border-radius': '6px', 'font-size': '11px', 'font-weight': '600',
  });
  const today = el(prefix + '.calendar-today-btn');
  const bar = el(prefix + '.calendar-rsvp-chips');
  expect(today.textContent).toBe('Today');
  expect(today.parentElement).toBe(bar);
  expect(group.parentElement).toBe(bar);
  expect(group.contains(today)).toBe(false);
  const todayBounds = today.getBoundingClientRect();
  const groupBounds = group.getBoundingClientRect();
  expect(todayBounds.left).toBeGreaterThanOrEqual(groupBounds.right + 8);
  expect(todayBounds.top + todayBounds.height / 2).toBe(groupBounds.top + groupBounds.height / 2);
  expect(todayBounds.right).toBe(bar.getBoundingClientRect().right - 16);
}

function panePalette(dark: boolean, prefix = '') {
  const r = reference[dark ? 'dark' : 'light'];
  const s = (selector: string, values: Record<string, string>) => style(prefix + selector, values);
  s('.calendar-pane', { 'background-color': r.surface, color: r.title, 'color-scheme': dark ? 'dark' : 'light' });
  s('.calendar-rsvp-chips', { 'background-color': r.surface });
  rsvpPalette(dark, prefix);
  s('.calendar-day-header', { 'background-color': r.header, color: rgb(dark, 'rgb(51, 51, 51)', 'rgb(238, 238, 238)') });
  s('.calendar-pane-footer', { 'background-color': r.surface, 'border-top-color': r.border });
  s('.calendar-event-title', { color: rgb(dark, 'rgb(15, 23, 42)', 'rgb(255, 255, 255)') });
  s('.calendar-event-time', { color: rgb(dark, 'rgb(100, 116, 139)', 'rgb(148, 163, 184)') });
  s('.calendar-event-organizer', { color: 'rgb(136, 136, 136)' });
  s('.calendar-event-calendar', { color: 'rgb(136, 136, 136)' });
  s('.calendar-event-calendar-dot', { 'background-color': 'rgb(101, 67, 33)' });
  s('.calendar-event-allday', { 'background-color': rgb(dark, 'rgb(248, 250, 252)', 'rgba(30, 41, 59, 0.8)'), 'border-color': rgb(dark, 'rgb(226, 232, 240)', 'rgb(51, 65, 85)') });
  for (const state of ['current', 'selected']) s(`.calendar-event-row--${state}`, {
    'background-color': rgb(dark, 'rgb(238, 242, 255)', 'rgba(30, 27, 75, 0.8)'),
    'border-color': rgb(dark, 'rgb(165, 180, 252)', 'rgb(55, 48, 163)'),
    'box-shadow': rgb(dark, 'rgba(99, 102, 241, 0.2) 0px 0px 0px 1px', 'rgba(129, 140, 248, 0.3) 0px 0px 0px 1px'),
  });
  s('.calendar-event-join', { color: rgb(dark, 'rgb(0, 169, 206)', 'rgb(34, 208, 239)'), 'border-color': rgb(dark, 'rgb(0, 169, 206)', 'rgb(34, 208, 239)') });
  for (const [status, light, night, lightBg, nightBg, lightBorder, nightBorder] of [
    ['accepted', 'rgb(5, 150, 105)', 'rgb(52, 211, 153)', 'rgb(236, 253, 245)', 'rgba(2, 44, 34, 0.8)', 'rgb(167, 243, 208)', 'rgb(6, 95, 70)'],
    ['tentative', 'rgb(245, 158, 11)', 'rgb(251, 191, 36)', 'rgb(255, 251, 235)', 'rgba(69, 26, 3, 0.8)', 'rgb(253, 230, 138)', 'rgb(146, 64, 14)'],
    ['needsAction', 'rgb(14, 165, 233)', 'rgb(56, 189, 248)', 'rgb(240, 249, 255)', 'rgba(8, 47, 73, 0.8)', 'rgb(186, 230, 253)', 'rgb(7, 89, 133)'],
    ['declined', 'rgb(244, 63, 94)', 'rgb(251, 113, 133)', 'rgb(255, 241, 242)', 'rgba(76, 5, 25, 0.8)', 'rgb(254, 205, 211)', 'rgb(159, 18, 57)'],
  ]) s(`.calendar-event-rsvp--${status}`, {
    color: dark ? night : light, 'background-color': dark ? nightBg : lightBg,
    'border-color': dark ? nightBorder : lightBorder,
    padding: '4px', 'border-radius': '4px', 'border-width': '1px', width: '14px', height: '14px',
  });
  for (const [status, light, night] of [
    ['accepted', 'rgb(5, 150, 105)', 'rgb(52, 211, 153)'],
    ['tentative', 'rgb(245, 158, 11)', 'rgb(251, 191, 36)'],
    ['needsAction', 'rgb(14, 165, 233)', 'rgb(56, 189, 248)'],
    ['declined', 'rgb(244, 63, 94)', 'rgb(251, 113, 133)'],
  ]) {
    s(`.calendar-event-rsvp--${status} svg`, { color: dark ? night : light, width: '14px', height: '14px' });
    s(`.calendar-event-rsvp--${status} path`, { stroke: dark ? night : light, 'stroke-width': '2.4px' });
  }
}
async function selectorPalette(dark: boolean, prefix = '') {
  // Click leaves the real pointer over the trigger; measure its resting palette.
  await userEvent.hover(el(prefix + '[role=searchbox]'));
  const r = reference[dark ? 'dark' : 'light'];
  const s = (selector: string, values: Record<string, string>) => style(prefix + selector, values);
  s('.calendar-selector', { 'color-scheme': dark ? 'dark' : 'light' });
   s('[role=combobox]', { color: r.title, 'background-color': r.surface, 'border-top-color': rgb(dark, 'rgb(118, 118, 118)', 'rgb(68, 68, 68)'), 'border-top-width': '1px', 'border-top-style': 'solid', 'color-scheme': dark ? 'dark' : 'light' });
  s('.calendar-selector-dropdown', { color: r.text, 'background-color': r.dropdown, 'box-shadow': r.shadow, 'border-color': rgb(dark, 'rgb(204, 204, 204)', 'rgb(51, 51, 51)') });
  s('.calendar-selector-heading', { color: r.text, opacity: '0.7' });
  s('[role=searchbox]', { color: rgb(dark, 'rgb(0, 0, 0)', 'rgb(238, 238, 238)'), 'background-color': rgb(dark, 'rgb(255, 255, 255)', 'rgb(42, 42, 42)'), 'border-top-color': rgb(dark, 'rgb(118, 118, 118)', 'rgb(68, 68, 68)'), 'border-top-width': dark ? '1px' : '2px', 'color-scheme': dark ? 'dark' : 'light' });
  s('.calendar-selector-actions button', { color: rgb(dark, 'rgb(0, 0, 0)', 'rgb(238, 238, 238)'), 'background-color': rgb(dark, 'rgb(239, 239, 239)', 'rgb(42, 42, 42)'), 'border-top-width': dark ? '1px' : '2px' });
  s('[role=option]', { color: rgb(dark, 'rgb(0, 0, 0)', 'rgb(238, 238, 238)'), 'border-top-width': '0px' });
  s('[data-active=true]', { 'background-color': r.active });
  s('.calendar-selector-checkbox', { 'accent-color': 'rgb(34, 166, 192)', 'color-scheme': dark ? 'dark' : 'light' });
  s('.calendar-selector-dot', { 'background-color': 'rgb(18, 52, 86)', width: '10px', height: '10px' });
}
function richProps() {
  const now = Date.now();
  const events = [...allRsvp].map((status, index) => makeEvent({
    id: `role-${index}`, calendarId: 'b', summary: `Role ${status}`, selfResponseStatus: status,
    organizer: { displayName: 'Organizer', self: false }, joinUrl: 'https://example.com/meeting',
    start: { dateTime: new Date(now - 60000).toISOString() },
    end: { dateTime: new Date(now + 3600000).toISOString() },
  }));
  events.push(makeEvent({ id: 'all-day', isAllDay: true, start: { date: '2026-10-24' }, end: { date: '2026-10-25' } }));
  const props = baseProps({ events, calendars, selectedCalendarIds: ['a', 'b'], selectedRsvpStatuses: allRsvp });
  const sources = [SOURCE, { id: 's2', email: 'second@example.com' }];
  return { ...props, sources, controller: createFakeController({ sources, events, calendars: { s1: calendars, s2: calendars }, selected: { s1: ['a', 'b'], s2: ['a'] } }) };
}

for (const os of ['light', 'dark'] as const) for (const theme of modes) {
  it(`pane and standalone role palettes: ${theme ?? 'omitted'} on ${os} OS`, async () => {
    await commands.scheme(os);
    const props = richProps();
    mount(<><section id="pane"><CalendarPane {...props} theme={theme} /></section><section id="standalone"><CalendarSelector calendars={calendars} selectedIds={['a']} onChange={() => {}} theme={theme} heading="Standalone account" /></section></>);
    const dark = (theme === 'system' || theme === undefined) ? os === 'dark' : theme === 'dark';
    panePalette(dark, '#pane ');
    await click('#pane [role=combobox]');
    await selectorPalette(dark, '#pane ');
    expect(el('#pane [role=heading]').textContent).toBe('me@example.com');
    expect(host.querySelectorAll('#pane [role=combobox]')).toHaveLength(1);
    expect(host.querySelectorAll('#pane [role=searchbox]')).toHaveLength(1);
    expect(el('#pane [role=group][aria-label="second@example.com"] [role=heading]').textContent).toBe('second@example.com');
    expect(host.querySelectorAll('#pane [role=group]')).toHaveLength(3);
    expect(host.querySelectorAll('#pane .calendar-selector [role=group]')).toHaveLength(2);
    for (const group of host.querySelectorAll('#pane .calendar-selector [role=group]')) {
      expect(Array.from(group.querySelectorAll('.calendar-selector-actions button'), button => button.textContent)).toEqual(['Select all', 'Clear']);
    }
    expect(host.querySelectorAll('#pane .calendar-selector-actions > button')).toHaveLength(5);
    style('#pane .calendar-selector', { 'color-scheme': dark ? 'dark' : 'light' });
    style('.calendar-event-source-dot', { 'background-color': 'rgb(66, 133, 244)', width: '8px', height: '8px' });
    await click('#standalone [role=combobox]');
    await selectorPalette(dark, '#standalone ');
    expect(el('#standalone [role=heading]').textContent).toBe('Standalone account');
    expect(el('#standalone [role=searchbox]')).toBe(document.activeElement);
    expect(el('#standalone [role=searchbox]').matches(':focus-visible')).toBe(true);
  });
}

for (const os of ['light', 'dark'] as const) {
  it(`system palette and T3 prototype chip geometry under ${os} OS`, async () => {
    await commands.scheme(os);
    mount(<CalendarPane {...baseProps({ events: [makeEvent({})], calendars, selectedCalendarIds: ['a'] })} />);
    const r = reference[os];
    style('.calendar-rsvp-chips', { 'background-color': r.surface });
    style('.calendar-pane-footer', { 'background-color': r.surface, 'border-top-color': r.border, 'min-height': '64px', padding: '12px 16px' });
    style('.calendar-day-header', { 'background-color': r.header, padding: '8px 16px' });
    style('.calendar-event-title', { color: rgb(os === 'dark', 'rgb(15, 23, 42)', 'rgb(255, 255, 255)') });
    style('.calendar-rsvp-chip.selected', { 'background-color': r.chip, height: '28px', padding: '6px', 'border-radius': '8px', 'border-width': '0px' });
    style('.calendar-event-row', { padding: '10px', 'border-width': '1px', 'border-radius': '12px' });
    await act(() => userEvent.click(el('[role=combobox]')));
    style('.calendar-selector-dropdown', { 'background-color': r.dropdown, color: r.text, 'box-shadow': r.shadow, 'min-width': '220px', padding: '8px', 'border-radius': '6px' });
    expect(el('[role=combobox]').getBoundingClientRect().top - el('.calendar-selector-dropdown').getBoundingClientRect().bottom).toBeCloseTo(6);
    style('[data-active=true]', { 'background-color': r.active, padding: '6px' });
  });
}

for (const os of ['light', 'dark'] as const) for (const state of ['disconnected', 'reauth', 'uncached-error', 'cached-error', 'loading', 'empty'] as const) {
  it(`${state} preserves literal copy, callbacks and palettes through all modes on ${os} OS`, async () => {
    await commands.scheme(os);
    const error = state.includes('error');
    const controller = createFakeController({
      sources: [SOURCE], status: { s1: state === 'reauth' ? 'needs-scope' : error ? 'error' : 'ok' },
      events: state === 'cached-error' ? [makeEvent({ summary: 'Cached appointment' })] : [],
      state: { loading: state === 'loading', error },
    });
    const onConnect = vi.fn();
    const onReconnect = vi.fn();
    const onRsvp = vi.fn();
    const props = { sources: [SOURCE], controller, connected: state !== 'disconnected', selectedRsvpStatuses: allRsvp, onRsvpStatusesChange: onRsvp, onConnect, onReconnect };
    mount(<CalendarPane {...props} />);
    const pane = el('.calendar-pane');
    const prompt = state === 'disconnected' || state === 'reauth';
    const copy = {
      disconnected: 'Not connected to Google Calendar.', reauth: 'Calendar connection needs reauthorization.',
      'uncached-error': "Couldn't load calendar events. Try again shortly.", 'cached-error': 'Cached appointment',
      loading: 'Loading calendar…', empty: 'No matching events in the next 30 days',
    }[state];
    for (const theme of [undefined, 'system', 'dark', 'light', undefined] as const) {
      act(() => root.render(<CalendarPane {...props} theme={theme} />));
      const dark = theme === 'dark' || ((theme === undefined || theme === 'system') && os === 'dark');
      expect(el('.calendar-pane')).toBe(pane);
      const selector = prompt ? '.calendar-pane-prompt p' : state === 'uncached-error' ? '[role=alert] p' : state === 'cached-error' ? '.calendar-event-title' : '.calendar-empty-state-text';
      expect(el(selector).textContent).toBe(copy);
      style('.calendar-pane', { 'background-color': reference[dark ? 'dark' : 'light'].surface, 'color-scheme': dark ? 'dark' : 'light' });
      style(selector, { color: prompt ? rgb(dark, 'rgb(85, 85, 85)', 'rgb(204, 204, 204)') : state === 'uncached-error' ? 'rgb(153, 153, 153)' : state === 'cached-error' ? rgb(dark, 'rgb(15, 23, 42)', 'rgb(255, 255, 255)') : reference[dark ? 'dark' : 'light'].title });
      if (prompt) {
        style('.calendar-connect-button', { color: rgb(dark, 'rgb(0, 169, 206)', 'rgb(34, 208, 239)'), 'background-color': reference[dark ? 'dark' : 'light'].surface, 'border-color': rgb(dark, 'rgb(0, 169, 206)', 'rgb(34, 208, 239)') });
        expect(el('.calendar-connect-button').textContent?.trim()).toBe(state === 'disconnected' ? 'Connect Google Calendar' : 'Reconnect to restore sync');
      }
      expect(onConnect).not.toHaveBeenCalled();
      expect(onReconnect).not.toHaveBeenCalled();
      expect(onRsvp).not.toHaveBeenCalled();
      expect(controller.refresh).not.toHaveBeenCalled();
    }
    if (prompt) {
      await click('.calendar-connect-button');
      expect(state === 'disconnected' ? onConnect : onReconnect).toHaveBeenCalledTimes(1);
      expect(state === 'disconnected' ? onReconnect : onConnect).not.toHaveBeenCalled();
    } else if (state === 'cached-error') expect(host.querySelector('[role=alert]')).toBeNull();
  });
}

for (const theme of ['light', 'dark'] as const) {
  it(`real hover, keyboard focus and dropdown guard/empty states in ${theme}`, async () => {
    await commands.scheme(theme === 'light' ? 'dark' : 'light');
    const props = richProps();
    const onChange = vi.fn();
    mount(<>
      <div id="hover-pane"><CalendarPane {...props} selectedRsvpStatuses={new Set(['accepted', 'tentative', 'declined'])} theme={theme} renderEventAction={() => <button className="calendar-event-insert-link" aria-label="Insert event">+</button>} /></div>
      <div id="hover-selector"><CalendarSelector calendars={calendars} selectedIds={['a']} onChange={onChange} theme={theme} heading="Account" /></div>
      <div id="no-calendars"><CalendarSelector calendars={[]} selectedIds={[]} onChange={() => {}} theme={theme} /></div>
      <div id="prompt"><CalendarPane {...baseProps({ connected: false })} theme={theme} /></div>
    </>);
    const dark = theme === 'dark';
    style('.calendar-event-insert-link', { color: rgb(dark, 'rgb(136, 136, 136)', 'rgb(153, 153, 153)') });
    await userEvent.hover(el('.calendar-event-insert-link'));
    style('.calendar-event-insert-link', { color: rgb(dark, 'rgb(34, 34, 34)', 'rgb(238, 238, 238)'), 'background-color': rgb(dark, 'rgba(0, 0, 0, 0.06)', 'rgba(255, 255, 255, 0.1)') });
    // Switch to keyboard modality, then move actual focus to the supported
    // insert action class. Its explicit outline is part of the original CSS.
    await act(() => userEvent.tab());
    el('.calendar-event-insert-link').focus();
    expect(el('.calendar-event-insert-link').matches(':focus-visible')).toBe(true);
    style('.calendar-event-insert-link', { 'outline-color': rgb(dark, 'rgb(26, 115, 232)', 'rgb(34, 208, 239)'), 'outline-style': 'solid', 'outline-width': '2px', 'outline-offset': '1px' });
    await userEvent.hover(el('.calendar-event-title-link'));
    style('.calendar-event-title-link .calendar-event-title', { 'text-decoration-line': 'underline' });
    await userEvent.hover(el('.calendar-event-join'));
    style('.calendar-event-join', { 'background-color': rgb(dark, 'rgb(240, 248, 251)', 'rgb(42, 42, 42)') });
    style('.calendar-rsvp-chip:not(.selected)', { 'background-color': 'rgba(0, 0, 0, 0)', 'box-shadow': 'none' });
    expect(el('.calendar-rsvp-chip:not(.selected)').getAttribute('aria-label')).toBe('Unaccepted (1)');
    expect(el('.calendar-rsvp-chip:not(.selected)').getAttribute('aria-pressed')).toBe('false');
    await userEvent.hover(el('.calendar-rsvp-chip:not(.selected)'));
    style('.calendar-rsvp-chip:not(.selected)', { 'background-color': reference[theme].chip, 'border-width': '0px', color: 'rgb(14, 165, 233)' });
    style('.calendar-rsvp-chip:not(.selected) svg', { color: 'rgb(14, 165, 233)' });
    await userEvent.hover(el('.calendar-today-btn'));
    style('.calendar-today-btn', { 'background-color': rgb(dark, 'rgb(226, 232, 240)', 'rgb(51, 65, 85)') });
    await userEvent.hover(el('#prompt .calendar-connect-button'));
    style('#prompt .calendar-connect-button', { 'background-color': rgb(dark, 'rgb(240, 248, 251)', 'rgb(42, 42, 42)') });
    await click('#hover-selector [role=combobox]');
    const search = el('[role=searchbox]');
    expect(document.activeElement).toBe(search);
    expect(search.matches(':focus-visible')).toBe(true);
    style('[role=searchbox]', { 'outline-style': 'auto', 'outline-width': '1px' });
    await userEvent.hover(el('[role=option]:not([data-active])'));
    style('[role=option]:not([data-active])', { 'background-color': dark ? 'rgb(42, 42, 42)' : 'rgba(0, 0, 0, 0)' });
    await userEvent.hover(el('[data-active=true]'));
    style('[data-active=true]', { 'background-color': reference[theme].active });
    await click('[role=option][aria-selected=true]');
    expect(onChange).not.toHaveBeenCalled();
    expect(el('[role=option][aria-selected=true]').textContent).toBe('Alpha');
    await fill('zz-no-match');
    expect(el('[role=listbox] p').textContent).toBe('No calendars found');
    style('[role=listbox] p', { color: reference[theme].text });
    await fill('');
    await key('{ArrowDown}');
    style('[data-active=true]', { 'background-color': reference[theme].active });
    await key('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    await click('.calendar-selector-actions button:nth-child(2)');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(['a']);
    await click('.calendar-selector-actions button:nth-child(1)');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    await click('.calendar-selector-actions button:nth-child(3)');
    expect(document.activeElement).toBe(el('#hover-selector [role=combobox]'));
    await click('#no-calendars [role=combobox]');
    expect(el('[role=listbox] p').textContent).toBe('No calendars available');
    style('[role=listbox] p', { color: reference[theme].text });
  });
}

for (const width of [360, 1000]) {
  it(`T3/T6 prototype controls and measured sticky geometry at ${width}px across modes`, async () => {
    await act(() => page.viewport(width, 900));
    const props = richProps();
    mount(<CalendarPane {...props} />);
    host.style.width = width === 360 ? '328px' : '720px';
    for (const os of ['light', 'dark'] as const) for (const theme of modes) {
      await commands.scheme(os);
      act(() => root.render(<CalendarPane {...props} theme={theme} />));
      style('.calendar-rsvp-chips', { padding: '12px 16px', gap: '8px', position: 'sticky', top: '0px' });
      const barHeight = el('.calendar-rsvp-chips').getBoundingClientRect().height;
      expect(barHeight).toBe(64);
      const dark = theme === 'dark' || ((theme === undefined || theme === 'system') && os === 'dark');
      rsvpPalette(dark);
      expect(el('.calendar-pane-footer').getBoundingClientRect().height).toBe(64);
      await expect.poll(() => getComputedStyle(el('.calendar-day-header')).top).toBe(`${barHeight}px`);
      style('.calendar-day-events', { gap: '8px', padding: '12px' });
      for (const selector of ['.calendar-event-row', '.calendar-event-allday']) {
        style(selector, { padding: '10px', gap: '6px', 'border-width': '1px', 'border-radius': '12px' });
        const card = el(selector);
        const header = card.querySelector('.calendar-event-header')!;
        const icon = header.lastElementChild!;
        expect(icon.getAttribute('role')).toBe('img');
        expect(card.querySelectorAll('[role=img]')).toHaveLength(1);
        const headerBounds = header.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        expect(iconBounds.right).toBe(headerBounds.right);
        expect(iconBounds.top).toBe(headerBounds.top);
        expect(iconBounds.width).toBe(24);
        expect(iconBounds.height).toBe(24);
        expect(icon.querySelector('svg')?.getAttribute('width')).toBe('14');
        expect(icon.querySelector('path')?.getAttribute('stroke-width')).toBe('2.4');
      }
      style('.calendar-event-title', { 'font-size': '12px', 'font-weight': '600', 'line-height': '15px' });
      style('.calendar-event-time', { 'font-size': '10px', 'min-width': '0px', 'font-weight': '600' });
      expect(getComputedStyle(el('.calendar-event-time')).fontFamily).toContain('ui-monospace');
      await click('[role=combobox]');
      expect(host.querySelectorAll('[role=combobox]')).toHaveLength(1);
      expect(host.querySelectorAll('[role=searchbox]')).toHaveLength(1);
      expect(host.querySelectorAll('[role=group]')).toHaveLength(3);
      expect(host.querySelectorAll('.calendar-selector [role=group]')).toHaveLength(2);
      expect(host.querySelectorAll('[role=option]')).toHaveLength(4);
      expect(el('.calendar-selector-dropdown').getBoundingClientRect().width).toBe(220);
      style('.calendar-selector-dropdown', { 'border-radius': '6px', padding: '8px', right: '0px' });
      expect(el('[role=combobox]').getBoundingClientRect().top - el('.calendar-selector-dropdown').getBoundingClientRect().bottom).toBeCloseTo(6);
      style('[role=listbox]', { 'max-height': '240px', gap: '2px' });
      style('[role=option]', { padding: '6px', gap: '8px' });
      style('.calendar-selector-name', { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
      await key('{Escape}');
    }
    // Wrapping changes the measured bar height; sticky headers must follow it.
    host.style.width = '180px';
    const wrappedHeight = el('.calendar-rsvp-chips').getBoundingClientRect().height;
    expect(wrappedHeight).toBeGreaterThan(64);
    await expect.poll(() => getComputedStyle(el('.calendar-day-header')).top).toBe(`${wrappedHeight}px`);
    await act(() => page.viewport(1000, 900));
  });
}

// T6: measure every RSVP variant, including plain timed cards (richProps makes
// every timed event current). Prototype rounded-xl is the final 12px radius.
for (const width of [360, 1000]) {
  it(`T6 literal plain card surfaces, borders and sibling spacing at ${width}px across modes`, async () => {
    await page.viewport(width, 900);
    const events = [true, false].flatMap(isAllDay => [...allRsvp].map((selfResponseStatus, index) => makeEvent({
      id: `${isAllDay ? 'allday' : 'timed'}-${selfResponseStatus}`, isAllDay, selfResponseStatus,
      start: isAllDay ? { date: '2026-10-24' } : { dateTime: `2026-10-24T${10 + index}:00:00` },
      end: isAllDay ? { date: '2026-10-25' } : { dateTime: `2026-10-24T${11 + index}:00:00` },
    })));
    const props = baseProps({ events, selectedRsvpStatuses: allRsvp });
    mount(<CalendarPane {...props} />);
    host.style.width = width === 360 ? '328px' : '720px';
    for (const os of ['light', 'dark'] as const) for (const theme of modes) {
      await commands.scheme(os);
      act(() => root.render(<CalendarPane {...props} theme={theme} />));
      const dark = theme === 'dark' || ((theme === undefined || theme === 'system') && os === 'dark');
      const cards = host.querySelectorAll<HTMLElement>('.calendar-day-events > :is(.calendar-event-row, .calendar-event-allday)');
      expect(cards).toHaveLength(8);
      expect(host.querySelector('.calendar-event-row--current, .calendar-event-row--selected')).toBeNull();
      cards.forEach((card, index) => {
        const selector = `.calendar-day-events > :nth-child(${index + 1})`;
        style(selector, {
          'background-color': rgb(dark, 'rgb(248, 250, 252)', 'rgba(30, 41, 59, 0.8)'),
          'border-color': rgb(dark, 'rgb(226, 232, 240)', 'rgb(51, 65, 85)'),
          'border-style': 'solid', 'border-width': '1px', 'border-right-width': '1px',
          'border-radius': '12px', padding: '10px', gap: '6px', 'box-shadow': 'none',
        });
        style(`${selector} .calendar-event-time`, { 'font-size': '10px', 'font-weight': '600' });
        expect(getComputedStyle(card.querySelector('.calendar-event-time')!).fontFamily).toContain('monospace');
        const bounds = card.getBoundingClientRect();
        const header = card.querySelector('.calendar-event-header')!.getBoundingClientRect();
        const icon = card.querySelector('[role=img]')!.getBoundingClientRect();
        expect(header.top).toBe(bounds.top + 11);
        expect(icon.right).toBe(bounds.right - 11);
        expect(icon.top).toBe(bounds.top + 11);
        expect(card.querySelector('.calendar-event-title-wrap')!.getBoundingClientRect().top - header.bottom).toBe(6);
        if (index > 0) {
          expect(card.parentElement).toBe(cards[index - 1].parentElement);
          expect(bounds.top - cards[index - 1].getBoundingClientRect().bottom).toBe(8);
        }
      });
    }
    await page.viewport(1000, 900);
  });

  it(`T6 current, selected and combined states remain distinct from plain cards at ${width}px across modes`, async () => {
    await page.viewport(width, 900);
    const now = Date.now();
    const timed = (id: string, start: number, end: number) => makeEvent({
      id, summary: id, start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() },
    });
    const hour = 3600000;
    const scenarios = [
      { name: 'overlapping-current', events: [timed('current-selected', now - hour, now + hour), timed('current-only', now - hour / 2, now + hour), timed('plain', now + 2 * hour, now + 3 * hour)], states: ['current', 'selected', 'current-selected'] },
      { name: 'upcoming-selected', events: [timed('selected-only', now + hour, now + 2 * hour), timed('plain', now + 3 * hour, now + 4 * hour)], states: ['selected'] },
    ];
    mount(<div />);
    host.style.width = width === 360 ? '328px' : '720px';
    for (const scenario of scenarios) {
      const props = baseProps({ events: scenario.events });
      for (const os of ['light', 'dark'] as const) for (const theme of modes) {
        await commands.scheme(os);
        act(() => root.render(<CalendarPane key={scenario.name} {...props} theme={theme} />));
        const dark = theme === 'dark' || ((theme === undefined || theme === 'system') && os === 'dark');
        const plainSelector = '.calendar-event-row:not(.calendar-event-row--current):not(.calendar-event-row--selected)';
        const plain = getComputedStyle(el(plainSelector));
        style(plainSelector, {
          'background-color': rgb(dark, 'rgb(248, 250, 252)', 'rgba(30, 41, 59, 0.8)'),
          'border-color': rgb(dark, 'rgb(226, 232, 240)', 'rgb(51, 65, 85)'), 'box-shadow': 'none',
        });
        expect(host.querySelectorAll('.calendar-event-row--current.calendar-event-row--selected')).toHaveLength(scenario.name === 'overlapping-current' ? 1 : 0);
        for (const state of scenario.states) {
          const selector = state === 'current-selected' ? '.calendar-event-row--current.calendar-event-row--selected'
            : state === 'current' ? '.calendar-event-row--current:not(.calendar-event-row--selected)'
              : scenario.name === 'upcoming-selected' ? '.calendar-event-row--selected:not(.calendar-event-row--current)' : '.calendar-event-row--selected';
          style(selector, {
            'background-color': rgb(dark, 'rgb(238, 242, 255)', 'rgba(30, 27, 75, 0.8)'),
            'border-color': rgb(dark, 'rgb(165, 180, 252)', 'rgb(55, 48, 163)'),
            'box-shadow': rgb(dark, 'rgba(99, 102, 241, 0.2) 0px 0px 0px 1px', 'rgba(129, 140, 248, 0.3) 0px 0px 0px 1px'),
            'border-width': '1px', 'border-right-width': '1px', 'border-radius': '12px',
          });
          const active = getComputedStyle(el(selector));
          for (const property of ['background-color', 'border-right-color', 'box-shadow']) {
            expect(active.getPropertyValue(property), `${state} differs from plain: ${property}`).not.toBe(plain.getPropertyValue(property));
          }
        }
      }
    }
    await page.viewport(1000, 900);
  });
}

it('explicit pane modes override the opposite OS palette', async () => {
  await commands.scheme('dark');
  mount(<CalendarPane {...baseProps({ events: [makeEvent({})] })} theme="light" />);
  style('.calendar-day-header', { 'background-color': reference.light.header });
  await commands.scheme('light');
  act(() => root.render(<CalendarPane {...baseProps({ events: [makeEvent({})] })} theme="dark" />));
  style('.calendar-day-header', { 'background-color': reference.dark.header });
});

it('live light → dark → light OS changes only system/omitted/undefined instances, including native controls and host slots', async () => {
  const props = richProps();
  mount(<>
    <aside id="host-sibling" style={{ color: '#abcdef', background: '#123456', border: '2px solid #654321', colorScheme: 'light' }}>Host</aside>
    {[undefined, 'system', 'light', 'dark', undefined].map((theme, i) => <section id={`live-${i}`} key={i}>
      <CalendarPane {...props} {...(i === 0 ? {} : { theme })} renderEventAction={() => <span className="host-slot" style={{ color: '#abcdef', background: '#123456', border: '2px solid #654321' }}>Host action</span>} />
      <CalendarSelector calendars={calendars} selectedIds={['a']} onChange={() => {}} {...(i === 0 ? {} : { theme })} heading="Standalone" />
    </section>)}
  </>);
  const htmlAttributes = document.documentElement.getAttributeNames().map(n => [n, document.documentElement.getAttribute(n)]);
  const bodyAttributes = document.body.getAttributeNames().map(n => [n, document.body.getAttribute(n)]);
  for (const os of ['light', 'dark', 'light'] as const) {
    await commands.scheme(os);
    for (let i = 0; i < 5; i++) {
      const dark = i === 3 || (i !== 2 && os === 'dark');
      panePalette(dark, `#live-${i} `);
      // The pane's unified grouped selector and its adjacent standalone selector.
      for (const suffix of ['.calendar-pane-footer .calendar-selector', ':scope > .calendar-selector']) {
        const section = el(`#live-${i}`);
        const trigger = section.querySelector<HTMLElement>(`${suffix} [role=combobox]`)!;
        await act(() => userEvent.click(trigger));
        await selectorPalette(dark, `#live-${i} `);
        style(`#live-${i} .calendar-selector-dropdown`, { 'color-scheme': dark ? 'dark' : 'light' });
        await key('{Escape}');
      }
      style(`#live-${i} .host-slot`, { color: 'rgb(171, 205, 239)', 'background-color': 'rgb(18, 52, 86)', 'border-color': 'rgb(101, 67, 33)' });
    }
    style('#host-sibling', { color: 'rgb(171, 205, 239)', 'background-color': 'rgb(18, 52, 86)', 'border-color': 'rgb(101, 67, 33)', 'color-scheme': 'light' });
    expect(document.documentElement.getAttributeNames().map(n => [n, document.documentElement.getAttribute(n)])).toEqual(htmlAttributes);
    expect(document.body.getAttributeNames().map(n => [n, document.body.getAttribute(n)])).toEqual(bodyAttributes);
  }
});

for (const os of ['light', 'dark'] as const) {
  it(`opposite nested panes and standalone selectors reset all palettes under ${os} OS`, async () => {
    await commands.scheme(os);
    const prompt = baseProps({ connected: false });
    mount(<>
      {(['light', 'dark'] as const).map(outer => <section id={`nested-${outer}`} key={outer}>
        <CalendarPane {...prompt} theme={outer} emptyState={<>
          <div id={`${outer}-own-pane`}><CalendarPane {...richProps()} theme={outer} /></div>
          <div id={`${outer}-child-pane`}><CalendarPane {...richProps()} theme={outer === 'light' ? 'dark' : 'light'} /></div>
          <div id={`${outer}-child-prompt`}><CalendarPane {...prompt} theme={outer === 'light' ? 'dark' : 'light'} /></div>
          <div id={`${outer}-system-pane`}><CalendarPane {...richProps()} theme="system" /></div>
          <div id={`${outer}-explicit`}><CalendarSelector theme={outer === 'light' ? 'dark' : 'light'} calendars={calendars} selectedIds={['a']} onChange={() => {}} heading="Nested explicit" /></div>
          <div id={`${outer}-system`}><CalendarSelector calendars={calendars} selectedIds={['a']} onChange={() => {}} heading="Nested system" /></div>
        </>} />
      </section>)}
    </>);
    for (const outer of ['light', 'dark']) {
      const innerDark = outer === 'light';
      style(`#nested-${outer} > .calendar-pane`, { 'background-color': reference[outer as 'light' | 'dark'].surface });
      style(`#${outer}-child-pane .calendar-pane`, { 'background-color': reference[innerDark ? 'dark' : 'light'].surface, 'color-scheme': innerDark ? 'dark' : 'light' });
      style(`#${outer}-child-prompt .calendar-pane-prompt p`, { color: innerDark ? 'rgb(204, 204, 204)' : 'rgb(85, 85, 85)' });
      panePalette(outer === 'dark', `#${outer}-own-pane `);
      panePalette(innerDark, `#${outer}-child-pane `);
      panePalette(os === 'dark', `#${outer}-system-pane `);
      for (const [kind, dark] of [['explicit', innerDark], ['system', os === 'dark']] as const) {
        await click(`#${outer}-${kind} [role=combobox]`);
        await selectorPalette(dark, `#${outer}-${kind} `);
        await key('{Escape}');
      }
    }
  });

  it(`live prop rerenders preserve current pane RSVP selection and standalone keyboard/search state on ${os} OS`, async () => {
    await commands.scheme(os);
    const props = richProps();
    const onRsvp = vi.fn();
    const onSelection = vi.fn();
    function Host({ theme }: { theme?: Theme }) {
      const [selection, setSelection] = useState<RsvpSelection>(new Set(['accepted', 'tentative']));
      const [selected, setSelected] = useState(['a']);
      return <>
        <div id="runtime-pane"><CalendarPane {...props} theme={theme} selectedRsvpStatuses={selection} onRsvpStatusesChange={next => { onRsvp(next); setSelection(next); }} /></div>
        <div id="runtime-selector"><CalendarSelector calendars={calendars} selectedIds={selected} onChange={next => { onSelection(next); setSelected(next); }} theme={theme} heading="Runtime account" /></div>
      </>;
    }
    mount(<Host theme="system" />);
    await click('#runtime-pane [aria-label="Unaccepted (1)"]');
    expect(onRsvp).toHaveBeenLastCalledWith(new Set(['accepted', 'tentative', 'needsAction']));
    // Exercise the internal selector and then the standalone selector with the
    // same uninterrupted prop cycle; both must keep real focused DOM nodes.
    for (const scope of ['#runtime-pane', '#runtime-selector']) {
      await click(`${scope} [role=combobox]`);
      await fill('a');
      await key('{ArrowDown}');
      const input = el('[role=searchbox]');
      const listbox = el('[role=listbox]');
      const active = listbox.getAttribute('aria-activedescendant');
      const option = el('[role=option][data-active=true]');
      expect(option.textContent).toBe('Beta');
      const trigger = el(`${scope} [role=combobox]`);
      for (const theme of ['system', 'dark', 'light', 'system', undefined] as const) {
        act(() => root.render(<Host theme={theme} />));
        const dark = theme === 'dark' || ((theme === 'system' || theme === undefined) && os === 'dark');
        expect(el('[role=searchbox]')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect((input as HTMLInputElement).value).toBe('a');
        expect(el('[role=listbox]')).toBe(listbox);
        expect(listbox.getAttribute('aria-activedescendant')).toBe(active);
        expect(el('[role=option][data-active=true]')).toBe(option);
        expect(el(`${scope} [role=combobox]`)).toBe(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        style('[data-active=true]', { 'background-color': reference[dark ? 'dark' : 'light'].active });
        style('#runtime-pane .calendar-rsvp-chip.selected', { 'background-color': reference[dark ? 'dark' : 'light'].chip });
        expect(el('#runtime-pane [aria-label="Unaccepted (1)"]').getAttribute('aria-pressed')).toBe('true');
        expect(el('#runtime-pane [aria-label="Accepted"]').getAttribute('aria-pressed')).toBe('true');
        expect(el('#runtime-pane [aria-label="Maybe"]').getAttribute('aria-pressed')).toBe('true');
        expect(onRsvp).toHaveBeenCalledTimes(1);
        expect(onSelection).not.toHaveBeenCalled();
        expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
        expect(props.controller.refresh).not.toHaveBeenCalled();
        expect(props.controller.hydrate).toHaveBeenCalledTimes(1);
      }
      // The same focused, filtered dropdown also survives real OS changes.
      for (const liveOs of ['light', 'dark', 'light', os] as const) {
        await commands.scheme(liveOs);
        style('[data-active=true]', { 'background-color': reference[liveOs].active });
        expect(el('[role=searchbox]')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect((input as HTMLInputElement).value).toBe('a');
        expect(listbox.getAttribute('aria-activedescendant')).toBe(active);
        expect(el('[role=option][data-active=true]')).toBe(option);
        expect(onRsvp).toHaveBeenCalledTimes(1);
        expect(onSelection).not.toHaveBeenCalled();
        expect(props.controller.setSelectedIds).not.toHaveBeenCalled();
      }
      await key('{Enter}');
      if (scope === '#runtime-pane') {
        // Starts with a+b, so keyboard toggling Beta removes it.
        expect(props.controller.setSelectedIds).toHaveBeenLastCalledWith('s1', ['a']);
        expect(props.controller.setSelectedIds).toHaveBeenCalledTimes(1);
        (props.controller.setSelectedIds as ReturnType<typeof vi.fn>).mockClear();
      } else {
        expect(onSelection).toHaveBeenCalledTimes(1);
        expect(onSelection).toHaveBeenLastCalledWith(['a', 'b']);
        expect(option.getAttribute('aria-selected')).toBe('true');
      }
      await key('{Escape}');
    }
    await click('#runtime-pane [aria-label="Unaccepted (1)"]');
    expect(onRsvp).toHaveBeenCalledTimes(2);
    expect(onRsvp).toHaveBeenLastCalledWith(new Set(['accepted', 'tentative']));
  });
}

it('standalone explicit selector palette overrides dark OS', async () => {
  await commands.scheme('dark');
  mount(<CalendarSelector calendars={calendars} selectedIds={['a']} onChange={() => {}} theme="light" heading="Account" />);
  await act(() => userEvent.click(el('[role=combobox]')));
  style('.calendar-selector-dropdown', { 'background-color': reference.light.dropdown, color: reference.light.text });
  style('[data-active=true]', { 'background-color': reference.light.active });
});
