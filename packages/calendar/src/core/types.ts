/** A connected account that calendars are read from. */
export interface Source {
  id: string;
  email: string;
  label?: string;
}

export type RsvpStatus = 'accepted' | 'tentative' | 'needsAction' | 'declined';

export interface CalendarEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  /** ID of the Source (account) this event came from. */
  sourceId: string;
  /** ID of the calendar this event belongs to. */
  calendarId?: string;
  summary: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  /** True iff `start.date` is present with no `start.dateTime`. */
  isAllDay: boolean;
  selfResponseStatus: RsvpStatus;
  joinUrl: string | null;
  organizer: { displayName?: string; email?: string; self: boolean };
  htmlLink: string;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  backgroundColor?: string;
  foregroundColor?: string;
  primary: boolean;
  accessRole: string;
  selected?: boolean;
}

export interface ParseContext {
  sourceId: string;
  calendarId: string;
}
