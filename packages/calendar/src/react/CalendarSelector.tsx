import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CalendarInfo } from '../core/types.js';
import { filterCalendarsByName, summarizeCalendarSelection } from '../core/events.js';

interface CalendarSelectorProps {
  calendars: CalendarInfo[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  /** Optional account heading (used when several sources are shown). */
  heading?: string;
}

export function CalendarSelector({ calendars, selectedIds, onChange, heading }: CalendarSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const visibleCalendars = filterCalendarsByName(calendars, query);
  const primaryId = calendars.find((calendar) => calendar.primary)?.id ?? calendars[0]?.id;

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      if (selectedIds.length === 1) return;
      onChange(selectedIds.filter((selectedId) => selectedId !== id));
      return;
    }
    onChange([...selectedIds, id]);
  }

  function selectAll() {
    const visibleIds = visibleCalendars.map((calendar) => calendar.id);
    onChange([...selectedIds, ...visibleIds.filter((id) => !selectedIds.includes(id))]);
  }

  function clear() {
    onChange(primaryId ? [primaryId] : []);
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (visibleCalendars.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % visibleCalendars.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + visibleCalendars.length) % visibleCalendars.length);
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const activeCalendar = visibleCalendars[activeIndex];
      if (activeCalendar) toggle(activeCalendar.id);
    }
  }

  const label = summarizeCalendarSelection(selectedIds, calendars);

  return (
    <div className="calendar-selector" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((isOpen) => !isOpen);
          setQuery('');
          setActiveIndex(0);
        }}
      >
        {label}
      </button>
      {open && (
        <div className="calendar-selector-dropdown calendar-selector-dropdown--upward" onKeyDown={handleListboxKeyDown}>
          {heading && (
            <div role="heading" aria-level={3} className="calendar-selector-heading">
              {heading}
            </div>
          )}
          <input
            ref={searchRef}
            type="search"
            role="searchbox"
            aria-label="Search calendars"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
          />
          <div className="calendar-selector-actions">
            <button type="button" onClick={selectAll}>Select all</button>
            <button type="button" onClick={clear}>Clear</button>
            <button type="button" onClick={close}>Done</button>
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            aria-activedescendant={visibleCalendars[activeIndex] ? `${listboxId}-${visibleCalendars[activeIndex].id}` : undefined}
            tabIndex={-1}
          >
            {calendars.length === 0 ? (
              <p>No calendars available</p>
            ) : visibleCalendars.length === 0 ? (
              <p>No calendars found</p>
            ) : (
              visibleCalendars.map((calendar, index) => (
                <button
                  key={calendar.id}
                  type="button"
                  id={`${listboxId}-${calendar.id}`}
                  role="option"
                  title={calendar.summary}
                  aria-selected={selectedIds.includes(calendar.id)}
                  data-active={index === activeIndex || undefined}
                  onClick={() => toggle(calendar.id)}
                >
                  <input
                    type="checkbox"
                    className="calendar-selector-checkbox"
                    checked={selectedIds.includes(calendar.id)}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <span
                    aria-hidden="true"
                    className="calendar-selector-dot"
                    data-testid={`calendar-color-${calendar.id}`}
                    style={{ backgroundColor: calendar.backgroundColor }}
                  />
                  <span className="calendar-selector-name" title={calendar.summary}>{calendar.summary}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
