import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paletteContractCss } from './cssPaletteContract.js';

const css = paletteContractCss(readFileSync(resolve(__dirname, '../styles.css'), 'utf8'));

describe('CalendarSelector dark mode CSS', () => {
  const start = css.lastIndexOf('@media (prefers-color-scheme: dark)');
  const dark = start >= 0 ? css.slice(start) : '';

  it('has a dark block styling the dropdown background and color', () => {
    expect(start).toBeGreaterThan(-1);
    expect(dark).toMatch(/\.calendar-selector-dropdown\s*\{[^}]*background:\s*#1a1a1a/);
    expect(dark).toMatch(/\.calendar-selector-dropdown\s*\{[^}]*color:\s*#eee/);
  });

  it('styles input, options and active option in dark mode', () => {
    expect(dark).toMatch(/\.calendar-selector-dropdown input\[type='search'\]\s*\{[^}]*color:/);
    expect(dark).toMatch(/\[role='option'\]\s*\{[^}]*color:/);
    expect(dark).toMatch(/\[data-active='true'\]\s*\{[^}]*#10262b/);
  });
});
