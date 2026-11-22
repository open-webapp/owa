// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeekStrip } from '../WeekStrip';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 21, 12));
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    height: 44, width: 280, top: 0, bottom: 44, left: 0, right: 280, x: 0, y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(16));
  });
}

function setup(today = new Date(2026, 10, 21, 12)) {
  const onSelect = vi.fn();
  const view = render(
    <div className="calendar-pane">
      <button className="calendar-today-btn" onClick={() => onSelect('2026-11-21')}>Today</button>
      <WeekStrip today={today} selected="2026-11-21" eventDays={new Set()} loading={false} onSelect={onSelect} />
    </div>,
  );
  const grid = screen.getByRole('rowgroup');
  Object.defineProperties(grid, {
    clientHeight: { configurable: true, value: 264 },
    scrollHeight: { configurable: true, get: () => grid.children.length * 44 },
  });
  function label(expected: string) {
    const labels = view.container.querySelectorAll('.calendar-weekstrip-month');
    expect(labels.length).toBe(1);
    expect(labels[0].textContent).toBe(expected);
  }
  function scroll(top: number) {
    grid.scrollTop = top;
    fireEvent.scroll(grid);
  }
  return { ...view, grid, label, scroll, onSelect };
}

describe('WeekStrip month label and Today reset', () => {
  it('shows the current initial month with exactly one label collapsed and expanded', () => {
    const { label } = setup();
    label('November');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle calendar weeks' }));
    label('November');
  });

  it('updates scrolling once per animation frame using the latest topmost row', () => {
    const { label, scroll } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle calendar weeks' }));
    scroll(2 * 44);
    scroll(3 * 44 + 10);
    label('November');
    expect(frames.size).toBe(1);
    flushFrame();
    label('December');
  });

  it('uses Wednesday rather than Sunday for a month-straddling row', () => {
    const { label } = setup(new Date(2026, 2, 31, 12));
    label('April');
  });

  it('shows the year across a year boundary and omits it in the browser-local current year', () => {
    const { label, scroll } = setup(new Date(2026, 11, 27, 12));
    label('December');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle calendar weeks' }));
    scroll(2 * 44);
    flushFrame();
    label('January 2027');
  });

  it('Today resets a shifted grid to the current week top, even when today is already selected', () => {
    const { grid, label, scroll, onSelect } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle calendar weeks' }));
    scroll(0); // Prepend earlier weeks, preserving the visible current week.
    flushFrame();
    scroll(15 * 44);
    flushFrame();
    label('December');
    scroll(16 * 44); // Leave a label update pending when Today is clicked.
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onSelect).toHaveBeenCalledWith('2026-11-21');
    expect(grid.scrollTop).toBe(0);
    expect(grid.firstElementChild?.getAttribute('aria-label')).toBe('Week of 2026-11-15');
    label('November');
    flushFrame();
    label('November');
    expect(screen.getByRole('button', { name: 'Toggle calendar weeks' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps exactly one label through scrolling, collapse, and re-expansion', () => {
    const { label, scroll } = setup();
    const handle = screen.getByRole('button', { name: 'Toggle calendar weeks' });
    fireEvent.click(handle);
    scroll(3 * 44);
    flushFrame();
    label('December');
    fireEvent.click(handle);
    label('November');
    fireEvent.click(handle);
    label('November');
  });
});
