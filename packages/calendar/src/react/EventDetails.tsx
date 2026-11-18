import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { CalendarEvent, CalendarInfo } from '../core/types.js';
import { getOrganizerLabel } from '../core/events.js';
import { RSVP_CHIPS, RsvpGlyph } from './CalendarPane.js';
import { formatEventWhen, htmlToPlainText, linkifyText } from './detailsText.js';

export interface EventDetailsProps {
  event: CalendarEvent;
  calendar?: CalendarInfo;
  sourceLabel: string;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}

const MAX_ATTENDEES = 10;
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

export function EventDetails({ event, calendar, sourceLabel, onClose, onOpenLink }: EventDetailsProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  const when = formatEventWhen(event.start.dateTime ?? event.start.date, event.end.dateTime ?? event.end.date, event.isAllDay);
  const organizer = getOrganizerLabel(event);
  const description = htmlToPlainText(event.description);
  const attendees = event.attendees ?? [];

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
        <div className="calendar-event-details-header">
          <span
            className="calendar-event-details-dot"
            aria-hidden="true"
            style={{ background: calendar?.backgroundColor }}
          />
          <h2 className="calendar-event-details-title">{event.summary}</h2>
          <button type="button" className="calendar-event-details-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="calendar-event-details-body">
          {when.date && (
            <section className="calendar-event-details-when">
              <span>{when.date}</span>
              {when.time && <span> {when.time}</span>}
            </section>
          )}
          {(calendar || sourceLabel) && (
            <section className="calendar-event-details-calendar">
              {calendar?.summary && <span>{calendar.summary}</span>}
              {sourceLabel && <span> {sourceLabel}</span>}
            </section>
          )}
          {organizer && <section className="calendar-event-details-organizer">{organizer}</section>}
          <section className="calendar-event-details-actions">
            {event.joinUrl && (
              <a href={event.joinUrl} target="_blank" rel="noopener noreferrer">
                Join
              </a>
            )}
            <Status status={event.selfResponseStatus} />
          </section>
          {event.location && <section className="calendar-event-details-location">{event.location}</section>}
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
          {attendees.length > 0 && (
            <section className="calendar-event-details-attendees">
              <ul>
                {attendees.slice(0, MAX_ATTENDEES).map((a, i) => (
                  <li key={`${a.email}-${i}`}>
                    <span>{a.displayName || a.email}</span> <Status status={a.responseStatus} />
                  </li>
                ))}
              </ul>
              {attendees.length > MAX_ATTENDEES && <div>+{attendees.length - MAX_ATTENDEES} more</div>}
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
