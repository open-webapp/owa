import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { makeEvent, baseProps } from './helpers.js';

const cals = [{ id: 'c0', summary: 'Cal', primary: true }];
const ev = makeEvent({ id: 'a', calendarId: 'c0', summary: 'Alpha' });

describe('overlay vs footer', () => {
  it('pane has footer modifier class only when footer is rendered', () => {
    const { container, unmount } = render(<CalendarPane {...baseProps({ events: [ev], calendars: cals, selectedCalendarIds: ['c0'] })} />);
    expect(container.querySelector('.calendar-pane')).toHaveClass('calendar-pane--has-footer');
    unmount();
    const r = render(<CalendarPane {...baseProps({ events: [ev] })} />);
    expect(r.container.querySelector('.calendar-pane')).not.toHaveClass('calendar-pane--has-footer');
  });

  it('pointerdown on footer closes overlay without preventing default; footer action proceeds', () => {
    render(<CalendarPane {...baseProps({ events: [ev], calendars: cals, selectedCalendarIds: ['c0'] })} />);
    fireEvent.click(screen.getByRole('link', { name: 'Alpha' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const trigger = screen.getByRole('combobox');
    expect(fireEvent.pointerDown(trigger)).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('backdrop click still closes', () => {
    render(<CalendarPane {...baseProps({ events: [ev], calendars: cals, selectedCalendarIds: ['c0'] })} />);
    fireEvent.click(screen.getByRole('link', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    void vi;
  });
});
