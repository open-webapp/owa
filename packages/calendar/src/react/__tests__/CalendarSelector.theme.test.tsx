import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CalendarSelector } from '../../index.js';

const calendars = [
  { id: 'primary', summary: 'Work primary', primary: true },
  { id: 'team', summary: 'Work team', primary: false },
  { id: 'home', summary: 'Home', primary: false },
];
type Theme = 'system' | 'light' | 'dark' | undefined;

describe('CalendarSelector theme prop', () => {
  it('keeps the open query, focus, keyboard choice and controlled selection through live changes', () => {
    const onChange = vi.fn();
    function Host({ theme }: { theme?: Theme }) {
      const [selectedIds, setSelectedIds] = useState(['primary']);
      return <CalendarSelector calendars={calendars} selectedIds={selectedIds} theme={theme}
        onChange={(ids) => { onChange(ids); setSelectedIds(ids); }} />;
    }
    const { container, rerender } = render(<Host theme="dark" />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'Work' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const listbox = screen.getByRole('listbox');
    const activeId = screen.getByRole('option', { name: 'Work team' }).id;
    for (const theme of ['light', 'system', undefined, 'dark'] as const) {
      rerender(<Host theme={theme} />);
      expect(container.firstChild).toHaveAttribute('data-calendar-theme', theme ?? 'system');
      expect(screen.getByRole('combobox')).toBe(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('searchbox')).toBe(search);
      expect(search).toHaveValue('Work');
      expect(search).toHaveFocus();
      expect(listbox).toHaveAttribute('aria-activedescendant', activeId);
      expect(screen.getByRole('option', { name: 'Work primary' })).toHaveAttribute('aria-selected', 'true');
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(['primary', 'team']);
    rerender(<Host theme="light" />);
    expect(screen.getByRole('option', { name: 'Work team' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenNthCalledWith(2, ['primary']);
    fireEvent.click(screen.getByRole('option', { name: 'Work primary' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('defaults to system when omitted and keeps separate instances independently interactive', () => {
    const onChange = vi.fn();
    const { container } = render(<>
      <CalendarSelector calendars={calendars} selectedIds={['primary']} onChange={onChange} />
      <CalendarSelector theme="dark" calendars={[]} selectedIds={[]} onChange={onChange} />
    </>);
    expect(container.children[0]).toHaveAttribute('data-calendar-theme', 'system');
    expect(container.children[1]).toHaveAttribute('data-calendar-theme', 'dark');
    fireEvent.click(screen.getAllByRole('combobox')[1]);
    expect(screen.getByText('No calendars available')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByText('No calendars found')).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });
});
