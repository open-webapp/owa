import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CalendarEvent, CalendarInfo, RsvpStatus } from '../core/types.js';
import { getOrganizerLabel } from '../core/events.js';
import { RSVP_CHIPS, RsvpGlyph, RsvpStatusIcon, formatTimeRange } from './CalendarPane.js';
import { htmlToPlainText, linkifyText } from './detailsText.js';
import { sortInvitees, summarizeInvitees } from './inviteeUtils.js';

export interface EventDetailsProps {
  event: CalendarEvent;
  calendar?: CalendarInfo;
  sourceLabel: string;
  onClose: () => void;
  onOpenLink: (url: string) => void;
  onRsvpChange?: (event: CalendarEvent, status: RsvpStatus) => void | Promise<void>;
  pending?: boolean;
  error?: boolean | string;
  onRetry?: () => void;
}

const RSVP_OPTIONS: { status: RsvpStatus; label: string }[] = [
  { status: 'accepted', label: 'Yes' },
  { status: 'tentative', label: 'Maybe' },
  { status: 'declined', label: 'No' },
];

const MAX_INVITEES = 10;
const FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';

function rsvpOf(status: string) {
  return RSVP_CHIPS.find((c) => c.status === status) ?? RSVP_CHIPS[3];
}

function Status({ status }: { status: string }) {
  const g = rsvpOf(status);
  return (
    <span className={`calendar-event-rsvp calendar-event-rsvp--${g.status}`}>
      <RsvpGlyph path={g.path} size={14} strokeWidth={2.4} /> {g.label}
    </span>
  );
}

export function EventDetails({ event, calendar, sourceLabel, onClose, onOpenLink, onRsvpChange, pending, error, onRetry }: EventDetailsProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const lastStatus = useRef<RsvpStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  const time = event.isAllDay ? 'All day' : formatTimeRange(event);
  const organizer = getOrganizerLabel(event);
  const description = htmlToPlainText(event.description);
  const attendees = event.attendees ?? [];
  const onlySelf = attendees.length === 1 && !!attendees[0].self;
  const showInvitees = attendees.length > 0 && !onlySelf;
  const invited = attendees.some((a) => a.self);
  const showRsvp = !!onRsvpChange && showInvitees && invited;
  const sorted = showInvitees ? sortInvitees(attendees) : [];
  const visible = expanded ? sorted : sorted.slice(0, MAX_INVITEES);

  function choose(status: RsvpStatus) {
    if (pending || !onRsvpChange) return;
    lastStatus.current = status;
    void onRsvpChange(event, status);
  }

  function retry() {
    if (onRetry) onRetry();
    else if (lastStatus.current) choose(lastStatus.current);
  }

  function onRadioKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const radios = Array.from(
      e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    );
    const i = radios.indexOf(e.currentTarget);
    radios[(i + dir + radios.length) % radios.length]?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === sheetRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const checkedStatus = RSVP_OPTIONS.some((o) => o.status === event.selfResponseStatus)
    ? event.selfResponseStatus
    : RSVP_OPTIONS[0].status;

  return (
    <div className="calendar-event-details" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        ref={sheetRef}
        className="calendar-event-details-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={event.summary}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="calendar-event-details-grabber" aria-hidden="true" />
        <div className="calendar-event-header calendar-event-details-toprow">
          <span className="calendar-event-time">{time}</span>
          <div className="calendar-event-actions">
            {event.joinUrl && (
              <a className="calendar-event-join" href={event.joinUrl} target="_blank" rel="noopener noreferrer">
                Join
              </a>
            )}
            <RsvpStatusIcon status={event.selfResponseStatus} />
            <button type="button" className="calendar-event-details-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="calendar-event-details-header">
          <h2 className="calendar-event-details-title">{event.summary}</h2>
        </div>
        <div className="calendar-event-details-body">
          {organizer && (
            <section className="calendar-event-details-organizer">
              <span>Organizer</span> <span>{organizer}</span>
              {event.organizer.self && <span> (you)</span>}
            </section>
          )}
          {(calendar || sourceLabel || event.location) && (
            <section className="calendar-event-details-calendar">
              <span
                className="calendar-event-details-dot"
                aria-hidden="true"
                style={{ background: calendar?.backgroundColor }}
              />
              {calendar?.summary && <span>{calendar.summary}</span>}
              {sourceLabel && <span> {sourceLabel}</span>}
              {event.location && <span className="calendar-event-details-location"> {event.location}</span>}
            </section>
          )}
          {description && (
            <section className="calendar-event-details-description" style={{ whiteSpace: 'pre-wrap' }}>
              {linkifyText(description).map((t, i) =>
                t.type === 'link' ? (
                  <a key={i} href={t.href} target="_blank" rel="noopener noreferrer">
                    {t.text}
                  </a>
                ) : (
                  <span key={i}>{t.text}</span>
                ),
              )}
            </section>
          )}
          {showInvitees && (
            <section className="calendar-event-details-invitees">
              <h3>Invitees ({attendees.length})</h3>
              <div className="calendar-event-details-invitee-summary">{summarizeInvitees(attendees)}</div>
              <ul>
                {visible.map((a, i) => (
                  <li key={`${a.email}-${i}`}>
                    <span>{a.displayName || a.email}</span>
                    {a.organizer && <span className="calendar-event-details-tag"> Organizer</span>}
                    {a.self && <span className="calendar-event-details-tag"> (you)</span>}{' '}
                    <Status status={a.responseStatus} />
                  </li>
                ))}
              </ul>
              {sorted.length > MAX_INVITEES && (
                <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Show fewer' : `Show all ${sorted.length}`}
                </button>
              )}
            </section>
          )}
          {showRsvp && (
            <section className="calendar-event-details-rsvp">
              <div role="radiogroup" aria-label="Change RSVP">
                {RSVP_OPTIONS.map((o) => (
                  <button
                    key={o.status}
                    type="button"
                    role="radio"
                    aria-checked={event.selfResponseStatus === o.status}
                    tabIndex={o.status === checkedStatus ? 0 : -1}
                    disabled={!!pending}
                    onClick={() => choose(o.status)}
                    onKeyDown={onRadioKeyDown}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div aria-live="polite" className="calendar-event-details-rsvp-status">
                {pending ? (
                  'Updating RSVP...'
                ) : error ? (
                  <>
                    <span>Couldn't update RSVP.</span>{' '}
                    <button type="button" onClick={retry}>
                      Retry
                    </button>
                  </>
                ) : null}
              </div>
            </section>
          )}
          {event.htmlLink && (
            <section className="calendar-event-details-open">
              <a
                href={event.htmlLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenLink(event.htmlLink);
                }}
              >
                Open in Google Calendar
              </a>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
