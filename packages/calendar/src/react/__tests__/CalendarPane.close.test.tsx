// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarPane, type CalendarPaneProps } from '../CalendarPane.js';

function renderPane(onClose?: () => void) {
  const controller = {
    subscribe: () => () => {},
    getEvents: () => [],
    getSourceStatus: () => ({}),
  } as unknown as CalendarPaneProps['controller'];
  return render(
    <CalendarPane
      sources={[]}
      controller={controller}
      connected
      selectedRsvpStatuses={new Set(['accepted'])}
      onRsvpStatusesChange={() => {}}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CalendarPane close button', () => {
  it('renders an X-only close button after Today', () => {
    renderPane(vi.fn());
    const today = screen.getByRole('button', { name: 'Scroll to today' });
    const close = screen.getByRole('button', { name: 'Close', exact: true });
    expect(today.nextElementSibling).toBe(close);
    expect(close.classList.contains('calendar-close-btn')).toBe(true);
    expect(close.textContent).toBe('×');
  });

  it('calls onClose once when clicked', () => {
    const onClose = vi.fn();
    renderPane(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is absent without onClose', () => {
    renderPane();
    expect(screen.queryByRole('button', { name: 'Close', exact: true })).toBeNull();
  });

  it('keeps Today then Close in DOM button order', () => {
    renderPane(vi.fn());
    const buttons = Array.from(document.querySelectorAll('.calendar-rsvp-chips button'));
    expect(buttons.slice(-2)).toEqual([
      screen.getByRole('button', { name: 'Scroll to today' }),
      screen.getByRole('button', { name: 'Close', exact: true }),
    ]);
  });

  it('has the accessible name exactly Close', () => {
    renderPane(vi.fn());
    expect(screen.getAllByRole('button', { name: /^Close$/ })).toHaveLength(1);
  });

  it('does not call onClose when Today is clicked', () => {
    const onClose = vi.fn();
    renderPane(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
