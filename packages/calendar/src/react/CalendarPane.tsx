import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CalendarEvent, RsvpStatus, Source } from '../core/types.js';
import type { CalendarController } from '../core/controller.js';
import {
  filterByRsvp,
  groupByDay,
  getOrganizerLabel,
  formatDayHeader,
  formatRibbonLabel,
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
  theme?: 'system' | 'light' | 'dark';
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

const RSVP_CHIPS: { status: RsvpStatus; label: string; path: string }[] = [
  {
    status: 'accepted',
    label: 'Accepted',
    path: 'M5 13l4 4L19 7',
  },
  {
    status: 'tentative',
    label: 'Maybe',
    path: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  {
    status: 'declined',
    label: 'Declined',
    path: 'M6 18L18 6M6 6l12 12',
  },
  {
    status: 'needsAction',
    label: 'Unaccepted',
    path: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  },
];

function RsvpGlyph({ path, size = 16, strokeWidth = 2.2 }: { path: string; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={path} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RsvpStatusIcon({ status }: { status: CalendarEvent['selfResponseStatus'] }) {
  const glyph = RSVP_CHIPS.find((chip) => chip.status === status) ?? RSVP_CHIPS[3];
  return (
    <span className={`calendar-event-rsvp calendar-event-rsvp--${glyph.status}`} role="img" aria-label={glyph.status} title={glyph.status}>
      <RsvpGlyph path={glyph.path} size={14} strokeWidth={2.4} />
    </span>
  );
}

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
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayParity(dateKey: string): 'even' | 'odd' {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000) % 2 === 0 ? 'even' : 'odd';
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
  const { sources, controller, selectedRsvpStatuses, theme = 'system' } = props;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<Window | null>(null);
  const [now, setNow] = useState(() => new Date());

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

  function handleToggle(status: RsvpStatus) {
    props.onRsvpStatusesChange(toggleRsvpStatus(selectedRsvpStatuses, status));
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
    const scrollEl = scrollRef.current;
    if (!chipsEl || !paneEl || !scrollEl) return;
    const ribbons = Array.from(scrollEl.querySelectorAll<HTMLElement>('.calendar-day-ribbon'));
    function updateRibbonWindows() {
      const viewport = scrollEl!.getBoundingClientRect();
      const chipsBottom = chipsEl!.getBoundingClientRect().bottom;
      for (const ribbon of ribbons) {
        const bounds = ribbon.getBoundingClientRect();
        const header = ribbon.parentElement?.previousElementSibling;
        const headerBottom = header?.getBoundingClientRect().bottom ?? chipsBottom;
        const top = Math.max(bounds.top, viewport.top, chipsBottom, headerBottom);
        const bottom = Math.min(bounds.bottom, viewport.bottom);
        ribbon.style.setProperty('--calendar-ribbon-window-top', `${Math.min(bounds.height, Math.max(0, top - bounds.top))}px`);
        ribbon.style.setProperty('--calendar-ribbon-window-height', `${Math.max(0, bottom - top)}px`);
      }
    }
    // Observe layout inputs only: the absolutely positioned window cannot resize them.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === scrollEl) {
          paneEl.style.setProperty('--calendar-scroll-height', `${entry.target.getBoundingClientRect().height}px`);
        } else if (entry.target === chipsEl) {
          // contentRect excludes padding; the sticky day-header offset needs the
          // chip row's full border-box height (chips have vertical padding).
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
          paneEl.style.setProperty('--chip-row-height', `${height}px`);
        }
      }
      updateRibbonWindows();
    });
    observer.observe(scrollEl);
    observer.observe(chipsEl);
    for (const header of dayHeaderRefs.current.values()) observer.observe(header);
    for (const ribbon of ribbons) observer.observe(ribbon);
    scrollEl.addEventListener('scroll', updateRibbonWindows, { passive: true });
    updateRibbonWindows();
    return () => {
      observer.disconnect();
      scrollEl.removeEventListener('scroll', updateRibbonWindows);
    };
  }, [connected, needsReauth, filteredEvents, todayIso, theme]);

  if (!connected) {
    return (
      <div className="calendar-pane" data-calendar-theme={theme}>
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
      <div className="calendar-pane" data-calendar-theme={theme}>
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
    <div className="calendar-pane" data-calendar-theme={theme} ref={paneRef}>
      <div className="calendar-pane-scroll" ref={scrollRef}>
      <div className="calendar-rsvp-chips" ref={chipsRef}>
        <div className="calendar-rsvp-chip-group" role="group" aria-label="RSVP Status Filters">
          {RSVP_CHIPS.map((chip) => (
            <button
              key={chip.status}
              type="button"
              className={`calendar-rsvp-chip${selectedRsvpStatuses.has(chip.status) ? ' selected' : ''}`}
              aria-pressed={selectedRsvpStatuses.has(chip.status)}
              aria-label={chip.status === 'needsAction' ? `${chip.label} (${unacceptedCount})` : chip.label}
              title={chip.status === 'needsAction' ? `${chip.label} (${unacceptedCount})` : chip.label}
              onClick={() => handleToggle(chip.status)}
            >
              <RsvpGlyph path={chip.path} />
              {chip.status === 'needsAction' && unacceptedCount > 0 && (
                <span className="calendar-rsvp-chip-badge" aria-hidden="true">
                  {unacceptedCount > 99 ? '99+' : unacceptedCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="calendar-today-btn"
          aria-label="Scroll to today"
          title="Scroll to today"
          onClick={() => recenter('smooth')}
        >
          Today
        </button>
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

              {group.events.length > 0 && (
              <div className="calendar-day-body">
              <div
                className="calendar-day-ribbon"
                aria-hidden="true"
                data-parity={dayParity(group.dateKey)}
              >
                <div className="calendar-day-ribbon-window">
                  <span className="calendar-day-ribbon-label">{formatRibbonLabel(group.dateKey)}</span>
                </div>
              </div>
              <div className="calendar-day-events">
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
                      <div className="calendar-event-header">
                        <span className="calendar-event-time">All day</span>
                        <RsvpStatusIcon status={event.selfResponseStatus} />
                      </div>
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
                      <div className="calendar-event-actions">
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
                        <RsvpStatusIcon status={event.selfResponseStatus} />
                      </div>
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
              </div>
              )}
            </div>
          ))}
          {loading && <p className="calendar-empty-state-text">Loading calendar…</p>}
          {filteredEvents.length === 0 && !loading && !error && needsScopeSources.length === 0 && <p className="calendar-empty-state-text">{emptyStateText}</p>}
        </div>
      )}
      </div>
      {showCalendarSelector && (
        <footer className="calendar-pane-footer">
          <GroupedCalendarSelector theme={theme} groups={calendarSources.map((s) => ({
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
