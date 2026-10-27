import { afterEach, expect, it } from 'vitest';
import { commands, userEvent } from '@vitest/browser/context';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarPane } from '../CalendarPane.js';
import { baseProps, makeEvent } from './helpers.js';
import '../styles.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

const statuses = ['accepted', 'tentative', 'needsAction', 'declined'] as const;
for (const theme of ['light', 'dark', 'system'] as const) {
  it(`wraps the complete Join/RSVP pair below time without clipping at 200px in ${theme}`, async () => {
    host = document.createElement('div');
    // The real pane's ribbon, gutters and card padding leave a 138px header:
    // time and actions each fit alone, but cannot fit together with the gap.
    host.style.cssText = 'width:200px;font:16px Arial';
    document.body.append(host);
    root = createRoot(host);
    const events = statuses.map((status) => makeEvent({
      id: status, selfResponseStatus: status,
      joinUrl: 'https://meet.google.com/pair',
      organizer: { displayName: 'Organizer', self: false },
    }));
    act(() => root.render(<CalendarPane {...baseProps({ events, selectedRsvpStatuses: new Set(statuses) })} theme={theme} />));
    for (const os of ['light', 'dark'] as const) {
      await commands.scheme(os);
      const rows = host.querySelectorAll<HTMLElement>('.calendar-event-row');
      expect(rows.length).toBe(4);
      for (const row of rows) {
        const header = row.querySelector<HTMLElement>('.calendar-event-header')!;
        const time = header.querySelector<HTMLElement>('.calendar-event-time')!;
        const actions = header.querySelector<HTMLElement>('.calendar-event-actions')!;
        const join = actions.querySelector<HTMLAnchorElement>('.calendar-event-join')!;
        const icon = actions.querySelector<HTMLElement>('.calendar-event-rsvp')!;
        const h = header.getBoundingClientRect();
        const t = time.getBoundingClientRect();
        const a = actions.getBoundingClientRect();
        const j = join.getBoundingClientRect();
        const r = icon.getBoundingClientRect();
        // Prove that this exercises a second flex line, not merely a narrow row.
        expect(t.left).toBe(h.left);
        expect(a.top).toBeGreaterThan(t.bottom);
        expect(j.top).toBeGreaterThan(t.bottom);
        expect(r.top).toBeGreaterThan(t.bottom);
        expect(a.right).toBe(h.right);
        expect(r.right).toBe(h.right);
        expect(j.top).toBe(r.top);
        expect(j.bottom).toBe(r.bottom);
        expect(r.left - j.right).toBe(4);
        expect(h.bottom).toBeGreaterThanOrEqual(a.bottom);
        // Bounds catch clipping/escape; scroll dimensions catch hidden overflow.
        for (const element of [row, header, time, actions, join, icon]) {
          const bounds = element.getBoundingClientRect();
          const container = (element === row ? host : element === header ? row : header).getBoundingClientRect();
          expect(bounds.left).toBeGreaterThanOrEqual(container.left);
          expect(bounds.right).toBeLessThanOrEqual(container.right);
          expect(element.scrollWidth).toBe(element.clientWidth);
        }
        const title = row.querySelector<HTMLElement>('.calendar-event-title-wrap')!.getBoundingClientRect();
        const organizer = row.querySelector<HTMLElement>('.calendar-event-organizer')!.getBoundingClientRect();
        expect(title.top).toBeGreaterThanOrEqual(h.bottom);
        expect(organizer.top).toBeGreaterThanOrEqual(h.bottom);
        expect(organizer.top).toBeGreaterThanOrEqual(title.bottom);
      }
    }
  });
}

for (const width of [360, 240]) for (const theme of ['light', 'dark', 'system'] as const) {
  it(`keeps the Join/RSVP pair compact and right aligned at ${width}px in ${theme}, through OS changes`, async () => {
    host = document.createElement('div');
    host.style.cssText = `width:${width}px;font:16px Arial`;
    document.body.append(host);
    root = createRoot(host);
    const events = statuses.flatMap((status) => [true, false].map((join) => makeEvent({
      id: `${status}-${join}`, selfResponseStatus: status,
      joinUrl: join ? 'https://meet.google.com/pair' : null,
      organizer: { displayName: 'Organizer', self: false },
    })));
    act(() => root.render(<CalendarPane {...baseProps({ events, selectedRsvpStatuses: new Set(statuses) })} theme={theme} />));
    for (const os of ['light', 'dark'] as const) {
      await commands.scheme(os);
      const rows = host.querySelectorAll<HTMLElement>('.calendar-event-row');
      expect(rows.length).toBe(8);
      for (const row of rows) {
        const header = row.querySelector<HTMLElement>('.calendar-event-header')!;
        const time = header.querySelector<HTMLElement>('.calendar-event-time')!;
        const icon = header.querySelector<HTMLElement>('.calendar-event-rsvp')!;
        const join = header.querySelector<HTMLAnchorElement>('.calendar-event-join');
        const h = header.getBoundingClientRect();
        const t = time.getBoundingClientRect();
        const r = icon.getBoundingClientRect();
        expect(t.left).toBe(h.left);
        expect(r.right).toBe(h.right);
        expect(r.height).toBe(24);
        expect(r.width).toBe(24);
        expect(row.scrollWidth).toBe(row.clientWidth);
        expect(row.querySelector('.calendar-event-title-wrap')!.getBoundingClientRect().top).toBeGreaterThanOrEqual(h.bottom);
        if (!join) {
          expect(header.querySelector('.calendar-event-actions')!.children.length).toBe(1);
          continue;
        }
        const j = join.getBoundingClientRect();
        expect(j.height).toBe(r.height);
        expect(j.top).toBe(r.top);
        expect(r.left - j.right).toBe(4);
        // Flex allocation rounds to subpixels at narrow widths.
        expect(j.left - t.right).toBeGreaterThanOrEqual(7.9);
        expect(j.width).toBeGreaterThan(r.width);
        expect(join.scrollWidth).toBe(join.clientWidth);
        expect(join.textContent).toBe('Join');
        expect(join.getAttribute('href')).toBe('https://meet.google.com/pair');
        expect(join.target).toBe('_blank');
        expect(join.rel).toBe('noopener noreferrer');
        for (const property of ['color', 'backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderTopStyle', 'borderRadius'] as const) {
          expect(getComputedStyle(join)[property], property).toBe(getComputedStyle(icon)[property]);
        }
      }
      // Native keyboard traversal reaches Join with a visible theme-colored outline.
      const join = host.querySelector<HTMLAnchorElement>('.calendar-event-join')!;
      (document.activeElement as HTMLElement)?.blur();
      const tabbable = host.querySelectorAll('button, a[href], input, [tabindex]').length;
      for (let i = 0; i <= tabbable && document.activeElement !== join; i++) await act(() => userEvent.tab());
      expect(document.activeElement).toBe(join);
      expect(join.matches(':focus-visible')).toBe(true);
      expect(getComputedStyle(join).outlineStyle).toBe('solid');
      expect(getComputedStyle(join).outlineWidth).toBe('2px');
      expect(getComputedStyle(join).outlineColor).toBe(theme === 'dark' || (theme === 'system' && os === 'dark') ? 'rgb(34, 208, 239)' : 'rgb(26, 115, 232)');
    }
  });
}
