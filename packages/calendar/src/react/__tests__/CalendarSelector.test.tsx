import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CalendarSelector } from '../CalendarSelector.js';
import type { CalendarInfo } from '../../core/types.js';

const calendars: CalendarInfo[] = [
  { id: 'primary', summary: 'Work', primary: true, backgroundColor: '#123456' },
  { id: 'family', summary: 'Family', backgroundColor: '#abcdef' },
  { id: 'team', summary: 'Team', backgroundColor: '#fedcba' },
];

function renderSelector(selectedIds = ['primary'], onChange = vi.fn(), items = calendars) {
  render(<CalendarSelector calendars={items} selectedIds={selectedIds} onChange={onChange} />);
  return onChange;
}

describe('CalendarSelector', () => {
  it('uses the selected calendar name or selected count for its button label', () => {
    const { rerender } = render(<CalendarSelector calendars={calendars} selectedIds={['primary']} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Work' })).toBeInTheDocument();

    rerender(<CalendarSelector calendars={calendars} selectedIds={['primary', 'family']} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: '2 calendars' })).toBeInTheDocument();
  });

  it('opens a multiselect listbox and Escape closes it, returning focus to the button', () => {
    renderSelector();
    const button = screen.getByRole('combobox', { name: 'Work' });
    fireEvent.click(button);
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('filters options case-insensitively and shows an empty message when none match', () => {
    renderSelector();
    fireEvent.click(screen.getByRole('combobox', { name: 'Work' }));
    const search = screen.getByRole('searchbox', { name: 'Search calendars' });
    fireEvent.change(search, { target: { value: 'FAM' } });
    expect(screen.getByRole('option', { name: 'Family' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Work' })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No calendars found')).toBeInTheDocument();
  });

  it('toggles an option with the next selected ids', () => {
    const onChange = renderSelector();
    fireEvent.click(screen.getByRole('combobox', { name: 'Work' }));
    fireEvent.click(screen.getByRole('option', { name: 'Family' }));
    expect(onChange).toHaveBeenCalledWith(['primary', 'family']);
  });

  it('selects filtered options or all options, and Clear keeps the primary calendar', () => {
    const onChange = renderSelector(['primary']);
    fireEvent.click(screen.getByRole('combobox', { name: 'Work' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search calendars' }), { target: { value: 'team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onChange).toHaveBeenCalledWith(['primary', 'team']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith(['primary']);
  });

  it('does not uncheck the last selected calendar', () => {
    const onChange = renderSelector(['primary']);
    fireEvent.click(screen.getByRole('combobox', { name: 'Work' }));
    fireEvent.click(screen.getByRole('option', { name: 'Work' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves the active option with arrows and toggles it with Space', () => {
    const onChange = renderSelector();
    fireEvent.click(screen.getByRole('combobox', { name: 'Work' }));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Family' })).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: 'Work' })).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(listbox, { key: ' ' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses combobox, selected option roles, and calendar background colors', () => {
    renderSelector(['primary', 'family']);
    fireEvent.click(screen.getByRole('combobox', { name: '2 calendars' }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
    expect(within(listbox).getByRole('option', { name: 'Team' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('calendar-color-family')).toHaveStyle({ backgroundColor: '#abcdef' });
  });

  it('renders an empty state without crashing when there are no calendars', () => {
    renderSelector([], vi.fn(), []);
    fireEvent.click(screen.getByRole('combobox', { name: '0 calendars' }));
    expect(screen.getByText('No calendars available')).toBeInTheDocument();
  });

  it('shows a checkbox per option reflecting selection', () => {
    renderSelector(['primary', 'team']);
    fireEvent.click(screen.getByRole('combobox', { name: '2 calendars' }));
    const boxes = screen.getAllByRole('option').map((o) => o.querySelector('input[type="checkbox"]') as HTMLInputElement);
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true]);
  });

  it('closes on outside click, Escape anywhere, and Done; aria-expanded tracks', () => {
    renderSelector();
    const button = screen.getByRole('combobox', { name: 'Work' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
