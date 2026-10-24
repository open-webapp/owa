import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import type { CalendarEvent, RsvpStatus, Source } from '../core/types.js';
import type { CalendarController } from '../core/controller.js';
import {
  filterByRsvp,
  groupByDay,
  getOrganizerLabel,
  formatDayHeader,
  isEventCurrent,
  findNextUpcomingEvent,
  getCalendarEventKey,
  DEFAULT_RSVP_STATUSES,
} from '../core/events.js';
import { GroupedCalendarSelector } from './CalendarSelector.js';

export type RsvpSelection = Set<RsvpStatus>;

function toggleRsvpStatus(selection: Iterable<RsvpStatus>, status: RsvpStatus): RsvpSelection {
  const next = new Set(selection);
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  return next.size === 0 ? new Set(DEFAULT_RSVP_STATUSES) : next;
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return width;
}

const SOURCE_COLORS = ['#4285f4', '#ea4335', '#34a853', '#fbbc04', '#a142f4', '#00acc1', '#ff7043', '#8d6e63'];

export interface CalendarPaneProps {
  sources: Source[];
  controller: CalendarController;
  selectedRsvpStatuses: RsvpSelection;
  onRsvpStatusesChange: (next: RsvpSelection) => void;
  renderEventAction?: (event: CalendarEvent) => ReactNode;
  emptyState?: ReactNode;
  sourceNotice?: (source: Source) => ReactNode;
  onClose?: () => void;
  /** Whether Google Calendar is connected. Defaults to `sources.length > 0`. */
  connected?: boolean;
  /** Whether the connection needs reauthorization. Defaults to all sources being 'needs-scope'. */
  needsReauth?: boolean;
  onConnect?: () => void;
  onReconnect?: () => void;
  /** Window name used for the event popup. */
  popupName?: string;
}

const RSVP_CHIPS: { status: RsvpStatus; label: string; icon: JSX.Element }[] = [
  {
    status: 'accepted',
    label: 'Accepted',
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
        <path
          d="M3 7.7L6 10.7L12 4.3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    status: 'tentative',
    label: 'Maybe',
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
        <path
          d="M5.2 5.6C5.2 4.2 6.2 3.2 7.5 3.2C8.8 3.2 9.8 4.2 9.8 5.4C9.8 6.8 7.6 6.9 7.6 8.8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="7.6" cy="11.2" r="0.9" fill="currentColor" />
      </svg>
    ),
  },
  {
    status: 'declined',
    label: 'Declined',
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
        <path d="M4 4L11 11M11 4L4 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    status: 'needsAction',
    label: 'Unaccepted',
    icon: (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
        <circle cx="7.5" cy="7.5" r="4.3" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
];

const DEFAULT_POPUP_NAME = 'notesdiary-cal-event';
const POPUP_W = 560;
const POPUP_H = 760;

function openEventPopup(url: string, popupRef: { current: Window | null }, popupName: string): void {
  const existingPopup = popupRef.current;
  if (existingPopup && !existingPopup.closed) {
    try {
      existingPopup.location = url;
      existingPopup.focus();
      return;
    } catch {
      popupRef.current = null;
    }
  }

  const left = Math.max(0, Math.round((window.screenX ?? 0) + (window.outerWidth - POPUP_W) / 2));
  const top = Math.max(0, Math.round((window.screenY ?? 0) + (window.outerHeight - POPUP_H) / 2));
  const popup = window.open(
    url,
    popupName,
    `popup,width=${POPUP_W},height=${POPUP_H},left=${left},top=${top}`
  );
  if (!popup) {
    window.open(url, '_blank');
    return;
  }
  popupRef.current = popup;
  try {
    popup.opener = null;
  } catch {
    // ignore
  }
  popup.focus();
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatTimeOfDay(dateTime: string): string {
  const d = new Date(dateTime);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatTimeRange(event: CalendarEvent): string {
  const startDateTime = event.start.dateTime;
  const endDateTime = event.end.dateTime;
  if (!startDateTime) return '';
  const start = formatTimeOfDay(startDateTime);
  if (!endDateTime) return start;
  return `${start} – ${formatTimeOfDay(endDateTime)}`;
}

function usableUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return trimmed === '' ? null : trimmed;
}

export function CalendarPane(props: CalendarPaneProps) {
  const isDesktop = useWindowWidth() >= 960;
  const { sources, controller, selectedRsvpStatuses } = props;
  const popupName = props.popupName ?? DEFAULT_POPUP_NAME;
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setVersion((v) => v + 1));
    setVersion((v) => v + 1);
    return unsubscribe;
  }, [controller]);
  useEffect(() => {
    if (typeof controller.hydrate === 'function') void Promise.resolve(controller.hydrate()).catch(() => {});
  }, [controller]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const events = useMemo(() => controller.getEvents(), [controller, version]);
  const statuses = controller.getSourceStatus();
  const connected = props.connected ?? sources.length > 0;
  const ctrlState =
    typeof controller.getState === 'function'
      ? controller.getState()
      : { loading: false, error: false, deferred: false, lastSyncAt: null };
  const multi = sources.length >= 2;
  const needsScopeSources = sources.filter((s) => statuses[s.id] === 'needs-scope');
  const needsReauth = connected && (props.needsReauth ?? (sources.length > 0 && needsScopeSources.length === sources.length));
  const sourceColor = (id: string) => SOURCE_COLORS[Math.max(0, sources.findIndex((s) => s.id === id)) % SOURCE_COLORS.length];
  const sourceEmail = (id: string) => sources.find((s) => s.id === id)?.email ?? '';
  const todayIso = toIsoDate(new Date());
  const dayHeaderRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const timedEventRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const hasScrolledForEventsRef = useRef(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<Window | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [savedSelection, setSavedSelection] = useState<Set<RsvpStatus> | null>(null);
  const isExclusive = selectedRsvpStatuses.size === 1 && selectedRsvpStatuses.has('needsAction');

  useEffect(() => {
    if (!isExclusive && savedSelection !== null) setSavedSelection(null);
  }, [isExclusive, savedSelection]);

  const unacceptedCount = useMemo(
    () => events.filter((event) => event.selfResponseStatus === 'needsAction').length,
    [events]
  );

  const filteredEvents = useMemo(
    () => filterByRsvp(events, selectedRsvpStatuses),
    [events, selectedRsvpStatuses]
  );

  const calendarsByKey = useMemo(() => {
    const map = new Map<string, ReturnType<CalendarController['getCalendars']>[number]>();
    for (const s of sources) for (const c of controller.getCalendars(s.id)) map.set(`${s.id}\u0000${c.id}`, c);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, controller, version]);

  const currentEventKeys = useMemo(() => {
    const ids = new Set<string>();
    for (const event of filteredEvents) {
      if (isEventCurrent(event, now)) {
        ids.add(getCalendarEventKey(event));
      }
    }
    return ids;
  }, [filteredEvents, now]);
  const nextUpcomingEvent = findNextUpcomingEvent(filteredEvents, now);
  const selectedEventKey = currentEventKeys.values().next().value ??
    (nextUpcomingEvent ? getCalendarEventKey(nextUpcomingEvent) : undefined);

  function handleUnaccepted() {
    if (isExclusive) {
      props.onRsvpStatusesChange(savedSelection ?? new Set(DEFAULT_RSVP_STATUSES));
      setSavedSelection(null);
    } else {
      setSavedSelection(new Set(selectedRsvpStatuses));
      props.onRsvpStatusesChange(new Set<RsvpStatus>(['needsAction']));
    }
  }

  function handleToggle(status: RsvpStatus) {
    const base = isExclusive ? savedSelection ?? DEFAULT_RSVP_STATUSES : selectedRsvpStatuses;
    if (isExclusive) setSavedSelection(null);
    props.onRsvpStatusesChange(toggleRsvpStatus(base, status));
  }
  const dayGroups = groupByDay(filteredEvents, todayIso);

  function scrollToToday(behavior: ScrollBehavior = 'auto') {
    const todayEl = dayHeaderRefs.current.get(todayIso);
    if (todayEl && typeof todayEl.scrollIntoView === 'function') {
      todayEl.scrollIntoView({ behavior, block: 'start' });
    }
  }

  function recenter(behavior: ScrollBehavior) {
    const el = selectedEventKey ? timedEventRefs.current.get(selectedEventKey) : undefined;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior, block: 'center' });
      return;
    }

    scrollToToday(behavior);
  }

  const recenterRef = useRef(recenter);
  recenterRef.current = recenter;
  const idleRecenteredRef = useRef(false);

  useEffect(() => {
    let idleTimeoutId: ReturnType<typeof setTimeout>;

    function fireIdle() {
      recenterRef.current('smooth');
      idleRecenteredRef.current = true;
    }

    function onActivity() {
      if (idleRecenteredRef.current) {
        idleRecenteredRef.current = false;
      }
      clearTimeout(idleTimeoutId);
      idleTimeoutId = setTimeout(fireIdle, 30000);
    }

    window.addEventListener('mousemove', onActivity);
    window.addEventListener('keydown', onActivity);
    window.addEventListener('click', onActivity);
    window.addEventListener('scroll', onActivity, { passive: true });
    window.addEventListener('touchstart', onActivity, { passive: true });

    onActivity();

    return () => {
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('click', onActivity);
      window.removeEventListener('scroll', onActivity);
      window.removeEventListener('touchstart', onActivity);
      clearTimeout(idleTimeoutId);
    };
  }, []);

  useEffect(() => {
    if (events.length === 0) {
      hasScrolledForEventsRef.current = false;
      return;
    }
    if (hasScrolledForEventsRef.current) return;
    recenterRef.current('auto');
    hasScrolledForEventsRef.current = true;
  }, [events, todayIso]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    function scheduleNext() {
      const nowMs = Date.now();
      let nextBoundaryMs = Infinity;
      for (const event of filteredEvents) {
        if (event.isAllDay) continue;
        const startMs = event.start.dateTime ? new Date(event.start.dateTime).getTime() : NaN;
        const endMs = event.end.dateTime ? new Date(event.end.dateTime).getTime() : NaN;
        if (!Number.isNaN(startMs) && startMs > nowMs && startMs < nextBoundaryMs) {
          nextBoundaryMs = startMs;
        }
        if (!Number.isNaN(endMs) && endMs > nowMs && endMs < nextBoundaryMs) {
          nextBoundaryMs = endMs;
        }
      }
      if (nextBoundaryMs !== Infinity) {
        timeoutId = setTimeout(() => {
          setNow(new Date());
          setTimeout(() => {
            if (idleRecenteredRef.current) {
              recenterRef.current('smooth');
            }
          }, 0);
          scheduleNext();
        }, nextBoundaryMs - nowMs);
      }
    }

    setNow(new Date());
    scheduleNext();

    return () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [filteredEvents]);

  useEffect(() => {
    const chipsEl = chipsRef.current;
    const paneEl = paneRef.current;
    if (!chipsEl || !paneEl) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // contentRect excludes padding; the sticky day-header offset needs the
      // chip row's full border-box height (chips have vertical padding).
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
      paneEl.style.setProperty('--chip-row-height', `${height}px`);
    });
    observer.observe(chipsEl);
    return () => observer.disconnect();
  }, [connected, needsReauth]);

  if (!connected) {
    return (
      <div className="calendar-pane">
        <div className="calendar-pane-prompt">
          {props.emptyState ?? (
            <>
              <p>Not connected to Google Calendar.</p>
              <button className="calendar-connect-button" onClick={props.onConnect}>
                Connect Google Calendar
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (needsReauth) {
    return (
      <div className="calendar-pane">
        <div className="calendar-pane-prompt">
          {props.sourceNotice && needsScopeSources.length > 0 ? (
            needsScopeSources.map((s) => <div key={s.id}>{props.sourceNotice?.(s)}</div>)
          ) : (
            <>
              <p>Calendar connection needs reauthorization.</p>
              <button className="calendar-connect-button" onClick={props.onReconnect}>
                Reconnect to restore sync
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const sourcesWithEvents = new Set(filteredEvents.map((e) => e.sourceId));
  const hasErrorWithoutEvents = sources.some((s) => statuses[s.id] === 'error' && !sourcesWithEvents.has(s.id));
  const calendarSources = sources.filter((s) => controller.getCalendars(s.id).length > 0);
  const error = hasErrorWithoutEvents || (ctrlState.error && filteredEvents.length === 0);
  const loading = ctrlState.loading && filteredEvents.length === 0;

  const emptyStateText = 'No matching events in the next 30 days';

  const showCalendarSelector = calendarSources.length > 0;

  return (
    <div className="calendar-pane" ref={paneRef}>
      <div className="calendar-pane-scroll">
      <div className="calendar-rsvp-chips" ref={chipsRef}>
        <button
          type="button"
          className="calendar-rsvp-chip calendar-scroll-today-btn"
          aria-label="Scroll to today"
          title="Scroll to today"
          onClick={() => recenter('smooth')}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <rect x="2" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M2 6H13" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M5 2V4M10 2V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <circle cx="7.5" cy="9.5" r="1.3" fill="currentColor"/>
          </svg>
        </button>
        {RSVP_CHIPS.map((chip) => (
          <button
            key={chip.status}
            type="button"
            className={`calendar-rsvp-chip${(chip.status === 'needsAction' ? isExclusive : selectedRsvpStatuses.has(chip.status)) ? ' selected' : ''}`}
            aria-pressed={chip.status === 'needsAction' ? isExclusive : selectedRsvpStatuses.has(chip.status)}
            aria-label={chip.status === 'needsAction' ? `${chip.label} (${unacceptedCount})` : chip.label}
            title={chip.status === 'needsAction' ? `${chip.label} (${unacceptedCount})` : chip.label}
            onClick={() => chip.status === 'needsAction' ? handleUnaccepted() : handleToggle(chip.status)}
          >
            {chip.icon}
            {chip.status === 'needsAction' && (
              <span className="calendar-rsvp-chip-badge" aria-hidden="true">
                {unacceptedCount > 99 ? '99+' : unacceptedCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {needsScopeSources.map((s) => (
        <div key={s.id}>{props.sourceNotice?.(s)}</div>
      ))}
      {error && (
        <div className="empty-state calendar-empty-state" role="alert">
          <p>Couldn't load calendar events. Try again shortly.</p>
        </div>
      )}
      {!(error && filteredEvents.length === 0) && (
        <div className="calendar-day-groups">
          {dayGroups.map((group) => (
            <div key={group.dateKey} className="calendar-day-group">
              <div
                className="calendar-day-header"
                ref={(el) => {
                  if (el) {
                    dayHeaderRefs.current.set(group.dateKey, el);
                  } else {
                    dayHeaderRefs.current.delete(group.dateKey);
                  }
                }}
              >
                {formatDayHeader(group.dateKey, todayIso)}
              </div>

              {group.events.map((event) => {
                const eventKey = getCalendarEventKey(event);
                const calendar = calendarsByKey.get(`${event.sourceId}\u0000${event.calendarId}`);
                const showCalendarLabel = calendar && !calendar.primary;
                const organizerLabel = getOrganizerLabel(event);
                const showOrganizerLabel = multi
                  ? true
                  : organizerLabel && (!showCalendarLabel || organizerLabel !== calendar.summary);
                const organizerText = multi
                  ? organizerLabel
                    ? `${organizerLabel} · ${sourceEmail(event.sourceId)}`
                    : sourceEmail(event.sourceId)
                  : organizerLabel;
                const rsvpStatus = RSVP_CHIPS.some((chip) => chip.status === event.selfResponseStatus)
                  ? event.selfResponseStatus
                  : 'needsAction';
                if (event.isAllDay) {
                  return (
                    <div key={eventKey} className={`calendar-event-allday calendar-event-row--rsvp-${rsvpStatus}`}>
                      <span className="calendar-event-title-wrap">
                        <span className="calendar-event-title">{event.summary}</span>
                        {props.renderEventAction?.(event)}
                      </span>
                      {showCalendarLabel && (
                        <span className="calendar-event-calendar">
                          <span className="calendar-event-calendar-dot" style={{ backgroundColor: calendar.backgroundColor }} />
                          {calendar.summary}
                        </span>
                      )}
                      {showOrganizerLabel && (
                        <span className="calendar-event-organizer">
                          {multi && (
                            <span
                              className="calendar-event-source-dot"
                              style={{ backgroundColor: sourceColor(event.sourceId) }}
                            />
                          )}
                          {organizerText}
                        </span>
                      )}
                    </div>
                  );
                }

                const hasLink = usableUrl(event.htmlLink) !== null;
                return (
                  <div
                     key={eventKey}
                     className={`calendar-event-row${
                       currentEventKeys.has(eventKey) ? ' calendar-event-row--current' : ''
                     }${
                       selectedEventKey === eventKey ? ' calendar-event-row--selected' : ''
                    } calendar-event-row--rsvp-${rsvpStatus}`}
                    ref={(el) => {
                      if (el) {
                         timedEventRefs.current.set(eventKey, el);
                       } else {
                         timedEventRefs.current.delete(eventKey);
                      }
                    }}
                  >
                    <div className="calendar-event-header">
                      <span className="calendar-event-time">{formatTimeRange(event)}</span>
                      {event.joinUrl && (
                        <a
                          className="calendar-event-join"
                          href={event.joinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Join
                        </a>
                      )}
                    </div>
                    <div className="calendar-event-title-wrap">
                      {hasLink ? (
                      <a
                        className="calendar-event-title-link"
                        href={event.htmlLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          if (
                            isDesktop &&
                            e.button === 0 &&
                            !e.ctrlKey &&
                            !e.metaKey &&
                            !e.shiftKey &&
                            !e.altKey
                          ) {
                            e.preventDefault();
                            openEventPopup(event.htmlLink, popupRef, popupName);
                          }
                        }}
                      >
                        <span className="calendar-event-title">{event.summary}</span>
                      </a>
                      ) : (
                        <span className="calendar-event-title">{event.summary}</span>
                      )}
                      {props.renderEventAction?.(event)}
                    </div>
                    {showCalendarLabel && (
                      <span className="calendar-event-calendar">
                        <span className="calendar-event-calendar-dot" style={{ backgroundColor: calendar.backgroundColor }} />
                        {calendar.summary}
                      </span>
                    )}
                    {showOrganizerLabel && (
                      <span className="calendar-event-organizer">
                          {multi && (
                            <span
                              className="calendar-event-source-dot"
                              style={{ backgroundColor: sourceColor(event.sourceId) }}
                            />
                          )}
                          {organizerText}
                        </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {loading && <p className="calendar-empty-state-text">Loading calendar…</p>}
          {filteredEvents.length === 0 && !loading && !error && needsScopeSources.length === 0 && <p className="calendar-empty-state-text">{emptyStateText}</p>}
        </div>
      )}
      </div>
      {showCalendarSelector && (
        <footer className="calendar-pane-footer">
          <GroupedCalendarSelector groups={calendarSources.map((s) => ({
              id: s.id,
              calendars: controller.getCalendars(s.id),
              selectedIds: controller.getSelectedIds(s.id),
              onChange: (ids) => {
                void controller.setSelectedIds(s.id, ids);
              },
              heading: multi ? s.email : undefined,
          }))} />
        </footer>
      )}
    </div>
  );
}
