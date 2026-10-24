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
  return <GroupedCalendarSelector groups={[{ id: '', calendars, selectedIds, onChange, heading }]} />;
}

/** Internal pane renderer; intentionally not re-exported from the package barrel. */
export function GroupedCalendarSelector({ groups }: { groups: (CalendarSelectorProps & { id: string })[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const visibleGroups = groups.map((group) => ({ ...group, visible: filterCalendarsByName(group.calendars, query) }));
  const visibleCalendars = visibleGroups.flatMap((group) => group.visible.map((calendar) => ({ calendar, group })));
  const optionId = (sourceId: string, calendarId: string) => `${listboxId}-${encodeURIComponent(JSON.stringify([sourceId, calendarId]))}`;

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

  function toggle(group: CalendarSelectorProps, id: string) {
    const { selectedIds, onChange } = group;
    if (selectedIds.includes(id)) {
      if (selectedIds.length === 1) return;
      onChange(selectedIds.filter((selectedId) => selectedId !== id));
      return;
    }
    onChange([...selectedIds, id]);
  }

  function selectAll(group: typeof visibleGroups[number]) {
    const { selectedIds, onChange } = group;
    const visibleIds = group.visible.map((calendar) => calendar.id);
    onChange([...selectedIds, ...visibleIds.filter((id) => !selectedIds.includes(id))]);
  }

  function clear({ calendars, onChange }: CalendarSelectorProps) {
    const primaryId = calendars.find((calendar) => calendar.primary)?.id ?? calendars[0]?.id;
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
      if (activeCalendar) toggle(activeCalendar.group, activeCalendar.calendar.id);
    }
  }

  const label = groups.length === 1
    ? summarizeCalendarSelection(groups[0].selectedIds, groups[0].calendars)
    : `${groups.reduce((count, group) => count + group.selectedIds.length, 0)} calendars selected`;
  const activeCalendar = visibleCalendars[activeIndex];

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
          {groups.length === 1 && groups[0].heading && (
            <div role="heading" aria-level={3} className="calendar-selector-heading">
              {groups[0].heading}
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
            {groups.length === 1 && <>
              <button type="button" onClick={() => selectAll(visibleGroups[0])}>Select all</button>
              <button type="button" onClick={() => clear(groups[0])}>Clear</button>
            </>}
            <button type="button" onClick={close}>Done</button>
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            aria-activedescendant={activeCalendar ? optionId(activeCalendar.group.id, activeCalendar.calendar.id) : undefined}
            tabIndex={-1}
          >
            {visibleGroups.map((group) => (
              <div key={group.id} role={groups.length > 1 ? 'group' : undefined} aria-label={group.heading}>
                {groups.length > 1 && <>
                  <div role="heading" aria-level={3} className="calendar-selector-heading">{group.heading}</div>
                  <div className="calendar-selector-actions">
                    <button type="button" onClick={() => selectAll(group)}>Select all</button>
                    <button type="button" onClick={() => clear(group)}>Clear</button>
                  </div>
                </>}
            {group.calendars.length === 0 ? (
              <p>No calendars available</p>
            ) : group.visible.length === 0 ? (
              <p>No calendars found</p>
            ) : (
              group.visible.map((calendar) => (
                <button
                  key={optionId(group.id, calendar.id)}
                  type="button"
                  id={optionId(group.id, calendar.id)}
                  role="option"
                  title={calendar.summary}
                  aria-selected={group.selectedIds.includes(calendar.id)}
                  data-active={(activeCalendar?.group.id === group.id && activeCalendar.calendar.id === calendar.id) || undefined}
                  onClick={() => toggle(group, calendar.id)}
                >
                  <input
                    type="checkbox"
                    className="calendar-selector-checkbox"
                    checked={group.selectedIds.includes(calendar.id)}
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
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
