import { afterEach, expect, it, vi } from 'vitest';
import { commands, userEvent } from '@vitest/browser/context';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarPane } from '../CalendarPane.js';
import { baseProps, makeEvent } from './helpers.js';
import '../styles.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });

function el(selector: string) {
  const element = host.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

for (const theme of ['light', 'dark'] as const) {
  it(`strip active palette matches the current event and literal values; dots and dimmed dates remain visible in ${theme}`, async () => {
    await commands.scheme(theme === 'light' ? 'dark' : 'light');
    vi.setSystemTime(new Date(2026, 10, 18, 12));
    const props = baseProps({ onClose: vi.fn(), events: [makeEvent({
      start: { dateTime: new Date(2026, 10, 18, 11).toISOString() },
      end: { dateTime: new Date(2026, 10, 18, 13).toISOString() },
    })] });
    host = document.createElement('div');
    host.style.cssText = 'width:360px;height:700px';
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<CalendarPane {...props} theme={theme} />));
    const literal = theme === 'light' ? {
      'background-color': 'rgb(238, 242, 255)', 'border-color': 'rgb(165, 180, 252)',
      'box-shadow': 'rgba(99, 102, 241, 0.2) 0px 0px 0px 1px',
    } : {
      'background-color': 'rgba(30, 27, 75, 0.8)', 'border-color': 'rgb(55, 48, 163)',
      'box-shadow': 'rgba(129, 140, 248, 0.3) 0px 0px 0px 1px',
    };
    const current = getComputedStyle(el('.calendar-event-row--current'));
    for (const selector of ['[aria-current="date"]', '.calendar-weekstrip-day[aria-pressed="true"]']) {
      const active = getComputedStyle(el(selector));
      for (const [property, value] of Object.entries(literal)) {
        expect(active.getPropertyValue(property), `${selector} ${property}`).toBe(current.getPropertyValue(property));
        expect(active.getPropertyValue(property), `${selector} literal ${property}`).toBe(value);
      }
    }
    const dot = el('.calendar-weekstrip-dot');
    expect(dot.getAttribute('aria-label')).toBe('Has events');
    expect(getComputedStyle(dot).color).toBe(theme === 'light' ? 'rgb(0, 169, 206)' : 'rgb(34, 208, 239)');
    expect(getComputedStyle(dot).visibility).toBe('visible');
    expect(dot.getBoundingClientRect().height).toBeGreaterThan(0);
    await act(() => userEvent.click(el('.calendar-weekstrip-handle')));
    const dimmed = el('[aria-label="2026-12-19"]');
    dimmed.scrollIntoView({ block: 'nearest' });
    expect(getComputedStyle(dimmed).opacity).toBe('0.5');
    expect(getComputedStyle(dimmed).visibility).toBe('visible');
    expect(dimmed.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(dimmed.getBoundingClientRect().bottom).toBeLessThanOrEqual(el('.calendar-weekstrip-weeks').getBoundingClientRect().bottom + 1);
    expect(host.querySelectorAll('.calendar-weekstrip')).toHaveLength(1);
    expect(host.querySelectorAll('.calendar-weekstrip-month')).toHaveLength(1);
    expect(host.querySelectorAll('.calendar-close-btn')).toHaveLength(1);
  });
}
