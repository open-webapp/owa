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

// Frozen before the token refactor: literal stylesheet palettes and fixed geometry.
// UA-native light controls were measured in pinned Chromium; no token-derived expectations.
const reference = {
  light: { surface: 'rgb(255, 255, 255)', border: 'rgb(238, 238, 238)', title: 'rgb(34, 34, 34)', header: 'rgb(245, 245, 245)', chip: 'rgb(8, 26, 89)', active: 'rgb(232, 245, 248)', dropdown: 'rgb(255, 255, 255)', text: 'rgb(26, 26, 26)', shadow: 'rgba(0, 0, 0, 0.15) 0px 4px 14px 0px' },
  dark: { surface: 'rgb(26, 26, 26)', border: 'rgb(51, 51, 51)', title: 'rgb(238, 238, 238)', header: 'rgb(34, 34, 34)', chip: 'rgb(34, 208, 239)', active: 'rgb(16, 38, 43)', dropdown: 'rgb(26, 26, 26)', text: 'rgb(238, 238, 238)', shadow: 'rgba(0, 0, 0, 0.5) 0px 4px 14px 0px' },
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
// unpressed chip #333/#eee + #ccc/#444; selected text #fff/#081a59;
// badge #e8eefb/#081a59 + #081a59/#e8eefb; all-day #fdf6e3/#2a2510;
// current/selected #f0f8fb/#10262b; time #666, organizer/calendar #888;
// error #999; insert #888/#999, hover #222/#eee, focus #1a73e8/#22d0ef.
// RSVP bars: #2e7d32/#4ade80, #d97706/#fbbf24, #2563eb/#60a5fa,
// #dc2626/#f87171. Dots retain host/calendar colors. Copy stays literal below.
function panePalette(dark: boolean, prefix = '') {
  const r = reference[dark ? 'dark' : 'light'];
  const s = (selector: string, values: Record<string, string>) => style(prefix + selector, values);
  s('.calendar-pane', { 'background-color': r.surface, color: r.title, 'color-scheme': dark ? 'dark' : 'light' });
  s('.calendar-rsvp-chips', { 'background-color': r.surface });
  s('.calendar-rsvp-chip:not(.selected)', { color: rgb(dark, 'rgb(51, 51, 51)', 'rgb(238, 238, 238)'), 'border-color': rgb(dark, 'rgb(204, 204, 204)', 'rgb(68, 68, 68)') });
  s('.calendar-rsvp-chip.selected', { 'background-color': r.chip, color: rgb(dark, 'rgb(255, 255, 255)', 'rgb(8, 26, 89)'), 'border-color': r.chip });
  s('.calendar-rsvp-chip-badge', { 'background-color': rgb(dark, 'rgb(232, 238, 251)', 'rgb(8, 26, 89)'), color: rgb(dark, 'rgb(8, 26, 89)', 'rgb(232, 238, 251)') });
  s('.calendar-day-header', { 'background-color': r.header, color: rgb(dark, 'rgb(51, 51, 51)', 'rgb(238, 238, 238)') });
  s('.calendar-pane-footer', { 'background-color': r.surface, 'border-top-color': r.border });
  s('.calendar-event-title', { color: r.title });
  s('.calendar-event-time', { color: 'rgb(102, 102, 102)' });
  s('.calendar-event-organizer', { color: 'rgb(136, 136, 136)' });
  s('.calendar-event-calendar', { color: 'rgb(136, 136, 136)' });
  s('.calendar-event-calendar-dot', { 'background-color': 'rgb(101, 67, 33)' });
  s('.calendar-event-allday', { 'background-color': rgb(dark, 'rgb(253, 246, 227)', 'rgb(42, 37, 16)'), 'border-bottom-color': r.border });
  s('.calendar-event-row--current', { 'background-color': rgb(dark, 'rgb(240, 248, 251)', 'rgb(16, 38, 43)') });
  s('.calendar-event-row--selected', { 'background-color': rgb(dark, 'rgb(240, 248, 251)', 'rgb(16, 38, 43)') });
  s('.calendar-event-join', { color: rgb(dark, 'rgb(0, 169, 206)', 'rgb(34, 208, 239)'), 'border-color': rgb(dark, 'rgb(0, 169, 206)', 'rgb(34, 208, 239)') });
  for (const [status, light, night] of [
    ['accepted', 'rgb(46, 125, 50)', 'rgb(74, 222, 128)'],
    ['tentative', 'rgb(217, 119, 6)', 'rgb(251, 191, 36)'],
    ['needsAction', 'rgb(37, 99, 235)', 'rgb(96, 165, 250)'],
    ['declined', 'rgb(220, 38, 38)', 'rgb(248, 113, 113)'],
  ]) s(`.calendar-event-row--rsvp-${status}`, { 'border-right-color': dark ? night : light });
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
    expect(host.querySelectorAll('#pane [role=group]')).toHaveLength(2);
    for (const group of host.querySelectorAll('#pane [role=group]')) {
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
  it(`original system palette and geometry under ${os} OS`, async () => {
    await commands.scheme(os);
    mount(<CalendarPane {...baseProps({ events: [makeEvent({})], calendars, selectedCalendarIds: ['a'] })} />);
    const r = reference[os];
    style('.calendar-rsvp-chips', { 'background-color': r.surface });
    style('.calendar-pane-footer', { 'background-color': r.surface, 'border-top-color': r.border, 'min-height': '64px', padding: '12px 16px' });
    style('.calendar-day-header', { 'background-color': r.header, padding: '8px 16px' });
    style('.calendar-event-title', { color: r.title });
    style('.calendar-rsvp-chip.selected', { 'background-color': r.chip, height: '32px' });
    style('.calendar-event-row', { padding: '10px 16px', 'border-right-width': '3px' });
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
      style(selector, { color: prompt ? rgb(dark, 'rgb(85, 85, 85)', 'rgb(204, 204, 204)') : state === 'uncached-error' ? 'rgb(153, 153, 153)' : reference[dark ? 'dark' : 'light'].title });
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
      <div id="hover-pane"><CalendarPane {...props} theme={theme} renderEventAction={() => <button className="calendar-event-insert-link" aria-label="Insert event">+</button>} /></div>
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
    await userEvent.hover(el('.calendar-rsvp-chip:not(.selected)'));
    style('.calendar-rsvp-chip:not(.selected)', { 'border-color': 'rgb(0, 169, 206)' });
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
  it(`frozen original mobile/desktop geometry remains intact at ${width}px across modes`, async () => {
    await act(() => page.viewport(width, 900));
    const props = richProps();
    mount(<CalendarPane {...props} />);
    host.style.width = width === 360 ? '328px' : '720px';
    for (const os of ['light', 'dark'] as const) for (const theme of modes) {
      await commands.scheme(os);
      act(() => root.render(<CalendarPane {...props} theme={theme} />));
      style('.calendar-rsvp-chips', { padding: '12px 16px', gap: '8px', position: 'sticky', top: '0px' });
      expect(el('.calendar-rsvp-chips').getBoundingClientRect().height).toBe(56);
      expect(el('.calendar-pane-footer').getBoundingClientRect().height).toBe(64);
      await expect.poll(() => getComputedStyle(el('.calendar-day-header')).top).toBe('56px');
      style('.calendar-event-row', { padding: '10px 16px', gap: '8px', 'border-right-width': '3px', 'border-bottom-width': '1px' });
      style('.calendar-event-title', { 'font-size': '14px' });
      style('.calendar-event-time', { 'font-size': '12px', 'min-width': '110px' });
      await click('[role=combobox]');
      expect(host.querySelectorAll('[role=combobox]')).toHaveLength(1);
      expect(host.querySelectorAll('[role=searchbox]')).toHaveLength(1);
      expect(host.querySelectorAll('[role=group]')).toHaveLength(2);
      expect(host.querySelectorAll('[role=option]')).toHaveLength(4);
      expect(el('.calendar-selector-dropdown').getBoundingClientRect().width).toBe(220);
      style('.calendar-selector-dropdown', { 'border-radius': '6px', padding: '8px', right: '0px' });
      expect(el('[role=combobox]').getBoundingClientRect().top - el('.calendar-selector-dropdown').getBoundingClientRect().bottom).toBeCloseTo(6);
      style('[role=listbox]', { 'max-height': '240px', gap: '2px' });
      style('[role=option]', { padding: '6px', gap: '8px' });
      style('.calendar-selector-name', { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
      await key('{Escape}');
    }
    await act(() => page.viewport(1000, 900));
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
          <div id={`${outer}-child-pane`}><CalendarPane {...prompt} theme={outer === 'light' ? 'dark' : 'light'} /></div>
          <div id={`${outer}-explicit`}><CalendarSelector theme={outer === 'light' ? 'dark' : 'light'} calendars={calendars} selectedIds={['a']} onChange={() => {}} heading="Nested explicit" /></div>
          <div id={`${outer}-system`}><CalendarSelector calendars={calendars} selectedIds={['a']} onChange={() => {}} heading="Nested system" /></div>
        </>} />
      </section>)}
    </>);
    for (const outer of ['light', 'dark']) {
      const innerDark = outer === 'light';
      style(`#nested-${outer} > .calendar-pane`, { 'background-color': reference[outer as 'light' | 'dark'].surface });
      style(`#${outer}-child-pane .calendar-pane`, { 'background-color': reference[innerDark ? 'dark' : 'light'].surface, 'color-scheme': innerDark ? 'dark' : 'light' });
      style(`#${outer}-child-pane .calendar-pane-prompt p`, { color: innerDark ? 'rgb(204, 204, 204)' : 'rgb(85, 85, 85)' });
      for (const [kind, dark] of [['explicit', innerDark], ['system', os === 'dark']] as const) {
        await click(`#${outer}-${kind} [role=combobox]`);
        await selectorPalette(dark, `#${outer}-${kind} `);
        await key('{Escape}');
      }
    }
  });

  it(`live prop rerenders preserve pane RSVP memory and standalone keyboard/search state on ${os} OS`, async () => {
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
    expect(onRsvp).toHaveBeenLastCalledWith(new Set(['needsAction']));
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
