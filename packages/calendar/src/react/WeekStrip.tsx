import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface WeekStripProps {
  today: Date;
  selected: string;
  eventDays: ReadonlySet<string>;
  loading: boolean;
  loadingDay?: string | null;
  onSelect: (dateKey: string) => void;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function WeekStrip({ today, selected, eventDays, loading, loadingDay, onSelect }: WeekStripProps) {
  const [expanded, setExpanded] = useState(false);
  const [window, setWindow] = useState({ first: 0, count: 12 });
  const [topWeek, setTopWeek] = useState(0);
  const monthFrame = useRef<number | null>(null);
  const pendingWeek = useRef(0);
  const weeksRef = useRef<HTMLDivElement>(null);
  const adjustment = useRef<number | null>(null);
  const pointer = useRef<{ id: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - start.getDay());
  const min = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
  const max = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30);
  const todayKey = dateKey(today);
  const wednesday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + topWeek * 7 + 3);
  const monthLabel = wednesday.toLocaleDateString('en-US', {
    month: 'long',
    ...(wednesday.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
  });
  function resetGrid() {
    if (monthFrame.current !== null) cancelAnimationFrame(monthFrame.current);
    monthFrame.current = null;
    setTopWeek(0);
    setWindow({ first: 0, count: 12 });
    adjustment.current = 0;
  }
  function toggle(next: boolean) {
    setExpanded(next);
    resetGrid();
  }
  useEffect(() => {
    // Today lives in the pane toolbar; observe its existing control without
    // adding another button or depending on a selected-date change.
    const pane = weeksRef.current?.closest('.calendar-pane');
    function onToday(event: Event) {
      if (event.target instanceof Element && event.target.closest('.calendar-today-btn')) resetGrid();
    }
    pane?.addEventListener('click', onToday);
    return () => {
      pane?.removeEventListener('click', onToday);
      if (monthFrame.current !== null) cancelAnimationFrame(monthFrame.current);
    };
  }, []);
  useLayoutEffect(() => {
    if (weeksRef.current && adjustment.current !== null) {
      weeksRef.current.scrollTop = adjustment.current;
      adjustment.current = null;
    }
  }, [expanded, window]);

  return (
    <div className="calendar-weekstrip" role="group" aria-label="Week" aria-busy={loading || !!loadingDay}>
      <div className="calendar-weekstrip-month">{monthLabel}</div>
      <div role="table" aria-label="Week dates">
        <div className="calendar-weekstrip-row" role="row">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
            <span key={index} role="columnheader">{label}</span>
          ))}
        </div>
        <div
          ref={weeksRef}
          className={`calendar-weekstrip-weeks${expanded ? ' calendar-weekstrip-weeks--expanded' : ''}`}
          role="rowgroup"
          onScroll={(event) => {
            if (!expanded || adjustment.current !== null) return;
            const element = event.currentTarget;
            const height = element.firstElementChild?.getBoundingClientRect().height ?? 0;
            if (!height) return;
            pendingWeek.current = window.first + Math.floor(Math.max(0, element.scrollTop) / height);
            if (monthFrame.current === null) {
              monthFrame.current = requestAnimationFrame(() => {
                monthFrame.current = null;
                setTopWeek(pendingWeek.current);
              });
            }
            if (element.scrollTop <= height) {
              adjustment.current = element.scrollTop + 12 * height;
              setWindow({ first: window.first - 12, count: Math.min(36, window.count + 12) });
            } else if (element.scrollHeight - element.clientHeight - element.scrollTop <= height) {
              const removed = Math.max(0, window.count + 12 - 36);
              adjustment.current = element.scrollTop - removed * height;
              setWindow({ first: window.first + removed, count: Math.min(36, window.count + 12) });
            }
          }}
        >
        {Array.from({ length: expanded ? window.count : 1 }, (_, week) => {
          const weekStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (expanded ? window.first + week : 0) * 7);
          return <div className="calendar-weekstrip-row calendar-weekstrip-week" role="row" aria-label={`Week of ${dateKey(weekStart)}`} key={dateKey(weekStart)}>
          {Array.from({ length: 7 }, (_, index) => {
            const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index);
            const key = dateKey(date);
            const outsideWindow = (date < min || date > max) && !eventDays.has(key);
            const isLoading = key === loadingDay;
            const isToday = key === todayKey;
            const isSelected = key === selected;
            const hasEvents = eventDays.has(key);
            const modifiers = [isToday && 'today', isSelected && 'selected', hasEvents && 'has-events', outsideWindow && 'outside-window', isLoading && 'loading'].filter(Boolean);
            return (
              <div key={key} role="cell">
                <button
                  type="button"
                  className={`calendar-weekstrip-day${modifiers.map((modifier) => ` calendar-weekstrip-day--${modifier}`).join('')}`}
                  aria-label={key}
                  aria-current={isToday ? 'date' : undefined}
                  aria-pressed={isSelected}
                  aria-busy={isLoading}
                  data-outside-window={outsideWindow}
                  onClick={() => onSelect(key)}
                >
                  {date.getDate()}
                  {(hasEvents || isLoading) && <span className="calendar-weekstrip-dot" role="img" aria-label={isLoading ? 'Loading events' : 'Has events'}>•</span>}
                </button>
              </div>
            );
          })}
        </div>;
        })}
        </div>
      </div>
      <button
        type="button"
        className="calendar-weekstrip-handle"
        aria-label="Toggle calendar weeks"
        aria-expanded={expanded}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          toggle(!expanded);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            suppressClick.current = false;
            toggle(!expanded);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressClick.current = false;
          pointer.current = { id: event.pointerId, y: event.clientY };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerUp={(event) => {
          const gesture = pointer.current;
          pointer.current = null;
          if (!gesture || gesture.id !== event.pointerId) return;
          const distance = event.clientY - gesture.y;
          if (Math.abs(distance) >= 24) {
            suppressClick.current = true;
            toggle(distance > 0);
          }
        }}
        onPointerCancel={() => { pointer.current = null; suppressClick.current = false; }}
        onLostPointerCapture={() => { pointer.current = null; }}
      >
        <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      </button>
    </div>
  );
}
