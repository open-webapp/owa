import { fireEvent, render, screen } from '@testing-library/react';
import { CalendarSelector } from '../CalendarSelector.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
const src = readFileSync(resolve(__dirname, '../CalendarSelector.tsx'), 'utf8');

describe('CalendarSelector long names', () => {
  it('caps dropdown width', () => {
    expect(css).toMatch(/\.calendar-selector-dropdown\s*\{[^}]*max-width:\s*min\(320px/);
    expect(css).toMatch(/\.calendar-selector-dropdown\s*\{[^}]*box-sizing:\s*border-box/);
  });
  it('dot cannot shrink and uses its own class', () => {
    expect(css).toMatch(/\.calendar-selector-dot\s*\{[^}]*flex:\s*none/);
    expect(css).not.toMatch(/\[role='option'\] span\s*\{/);
  });
  it('name is clipped on one line within its own element', () => {
    expect(css).toMatch(/\.calendar-selector-name\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.calendar-selector-name\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.calendar-selector-name\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.calendar-selector-name\s*\{[^}]*white-space:\s*nowrap/);
    expect(src).toMatch(/className="calendar-selector-name"/);
    expect(src).toMatch(/className="calendar-selector-dot"/);
  });
});

describe('CalendarSelector render with long names', () => {
  const long = 'A very long calendar name '.repeat(8).trim();
  const url = 'https://calendar.example.com/ical/some.person%40example.com/private-0123456789abcdef/basic.ics';
  const items = [
    { id: 'a', summary: 'Work', backgroundColor: '#111111' },
    { id: 'b', summary: long, backgroundColor: '#222222' },
    { id: 'c', summary: url, backgroundColor: '#333333' },
    { id: 'd', summary: 'Family', backgroundColor: '#444444' },
  ];
  it('renders every option with checkbox, dot, and full name exposed on hover', () => {
    render(<CalendarSelector calendars={items} selectedIds={['a']} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(4);
    items.forEach((c, i) => {
      expect(opts[i].querySelector('input[type="checkbox"]')).not.toBeNull();
      expect(screen.getByTestId(`calendar-color-${c.id}`)).toHaveClass('calendar-selector-dot');
      const name = opts[i].querySelector('.calendar-selector-name')!;
      expect(name).toHaveTextContent(c.summary);
      expect(name).toHaveAttribute('title', c.summary);
      expect(opts[i]).toHaveAttribute('title', c.summary);
    });
  });
});
