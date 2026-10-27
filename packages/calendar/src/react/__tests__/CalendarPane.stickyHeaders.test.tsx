import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { makeEvent, baseProps } from './helpers.js';
import { paletteContractCss } from './cssPaletteContract.js';

// Extracts the CSS rule body for a given selector, e.g. ".calendar-day-header { ... }".
function extractRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) {
    throw new Error(`Could not find CSS rule for selector "${selector}"`);
  }
  return match[1];
}

describe('CalendarPane sticky headers CSS contract', () => {
  const cssPath = path.resolve(__dirname, '../styles.css');
  const css = paletteContractCss(fs.readFileSync(cssPath, 'utf-8'));

  it('.calendar-rsvp-chips is sticky, pinned to the top of the scroll container', () => {
    const body = extractRuleBody(css, '.calendar-rsvp-chips');
    expect(body).toMatch(/position:\s*sticky/);
    expect(body).toMatch(/top:\s*0\b/);
  });

  it('.calendar-day-header is sticky, pinned below the chip row via the dynamic CSS variable (not a hardcoded px value)', () => {
    const body = extractRuleBody(css, '.calendar-day-header');
    expect(body).toMatch(/position:\s*sticky/);
    expect(body).toMatch(/top:\s*var\(--chip-row-height/);
  });

  it('uses clearly distinct RSVP indicator colors in each color scheme', () => {
    expect(css).not.toContain('--rsvp-bar');
    for (const [status, light, dark] of [
      ['accepted', '#059669', '#34d399'],
      ['tentative', '#f59e0b', '#fbbf24'],
      ['needsAction', '#0ea5e9', '#38bdf8'],
      ['declined', '#f43f5e', '#fb7185'],
    ]) {
      expect(extractRuleBody(css, `.calendar-event-rsvp--${status}`)).toContain(`--status-text: ${light}`);
      expect(css).toMatch(new RegExp(`@media\\s*\\(prefers-color-scheme:\\s*dark\\)[\\s\\S]*\\.calendar-event-rsvp--${status}\\s*\\{\\s*--status-text:\\s*${dark}`));
    }
  });
});

describe('CalendarPane chip-row height measurement', () => {
  let resizeCallback: ResizeObserverCallback | null = null;
  let observedElements: Element[] = [];
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    observedElements = [];
    class ResizeObserverStub {
      callback: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.callback = cb;
        resizeCallback = cb;
      }
      observe(el: Element) {
        observedElements.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    resizeCallback = null;
  });

  it('writes the observed chip-row border-box height to the --chip-row-height CSS custom property on the pane root', () => {
    const events = [makeEvent({})];
    const { container } = render(<CalendarPane {...baseProps({ events })} />);

    const paneEl = container.querySelector('.calendar-pane') as HTMLElement;
    const chipsEl = container.querySelector('.calendar-rsvp-chips') as HTMLElement;
    expect(paneEl).not.toBeNull();
    expect(chipsEl).not.toBeNull();
    expect(observedElements).toContain(chipsEl);
    expect(resizeCallback).not.toBeNull();

    resizeCallback!(
      [
        {
          target: chipsEl,
          contentRect: { height: 32 } as DOMRectReadOnly,
          borderBoxSize: [{ blockSize: 87, inlineSize: 340 }],
        } as unknown as ResizeObserverEntry,
      ],
      {} as ResizeObserver
    );

    expect(paneEl.style.getPropertyValue('--chip-row-height')).toBe('87px');
  });

  it('uses the chip row border-box height, not the padding-excluded contentRect height (regression: chips have vertical padding, so contentRect undershoots)', () => {
    const events = [makeEvent({})];
    const { container } = render(<CalendarPane {...baseProps({ events })} />);

    const paneEl = container.querySelector('.calendar-pane') as HTMLElement;
    const chipsEl = container.querySelector('.calendar-rsvp-chips') as HTMLElement;

    // contentRect excludes the chip row's 12px top/bottom padding (32px content
    // vs. 56px full row height) — the sticky header offset must use the latter.
    resizeCallback!(
      [
        {
          target: chipsEl,
          contentRect: { height: 32 } as DOMRectReadOnly,
          borderBoxSize: [{ blockSize: 56, inlineSize: 340 }],
        } as unknown as ResizeObserverEntry,
      ],
      {} as ResizeObserver
    );

    expect(paneEl.style.getPropertyValue('--chip-row-height')).toBe('56px');
    expect(paneEl.style.getPropertyValue('--chip-row-height')).not.toBe('32px');
  });

  it('falls back to the target element bounding rect height when borderBoxSize is unavailable', () => {
    const events = [makeEvent({})];
    const { container } = render(<CalendarPane {...baseProps({ events })} />);

    const paneEl = container.querySelector('.calendar-pane') as HTMLElement;
    const chipsEl = container.querySelector('.calendar-rsvp-chips') as HTMLElement;
    chipsEl.getBoundingClientRect = () => ({ height: 56 } as DOMRect);

    resizeCallback!(
      [
        {
          target: chipsEl,
          contentRect: { height: 32 } as DOMRectReadOnly,
        } as unknown as ResizeObserverEntry,
      ],
      {} as ResizeObserver
    );

    expect(paneEl.style.getPropertyValue('--chip-row-height')).toBe('56px');
  });
});
