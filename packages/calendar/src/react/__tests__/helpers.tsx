import { vi } from 'vitest';
import type { ReactNode } from 'react';
import type { CalendarController, CalendarControllerState, SourceStatus } from '../../core/controller.js';
import { DEFAULT_RSVP_STATUSES } from '../../core/events.js';
import type { CalendarEvent, CalendarInfo, RsvpStatus, Source } from '../../core/types.js';

export type RsvpSelection = Set<RsvpStatus>;

export const SOURCE: Source = { id: 's1', email: 'me@example.com' };

export function makeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'evt-1',
    sourceId: 's1',
    summary: 'Event',
    start: { dateTime: '2026-09-27T10:00:00Z' },
    end: { dateTime: '2026-09-27T11:00:00Z' },
    isAllDay: false,
    selfResponseStatus: 'accepted',
    joinUrl: null,
    organizer: { self: false },
    htmlLink: 'https://calendar.google.com/event?eid=evt-1',
    ...overrides,
  };
}

export interface FakeControllerOptions {
  sources: Source[];
  events?: CalendarEvent[];
  status?: Record<string, SourceStatus>;
  calendars?: Record<string, CalendarInfo[]>;
  selected?: Record<string, string[]>;
  state?: Partial<CalendarControllerState>;
}

/**
 * In-memory CalendarController. Selection is stateful and mimics the real
 * controller's rule that at least one calendar stays selected.
 */
export function createFakeController(opts: FakeControllerOptions): CalendarController {
  const listeners = new Set<() => void>();
  const status: Record<string, SourceStatus> = Object.fromEntries(
    opts.sources.map((s) => [s.id, opts.status?.[s.id] ?? 'ok']),
  );
  const selected: Record<string, string[]> = { ...opts.selected };
  const calendars = opts.calendars ?? {};
  const events = opts.events ?? [];
  const notify = () => listeners.forEach((l) => l());

  async function setSelected(id: string, ids: string[]) {
    const next = [...new Set(ids)];
    if (next.length === 0) return;
    selected[id] = next;
    notify();
  }

  const state: CalendarControllerState = { loading: false, error: false, deferred: false, lastSyncAt: null, ...opts.state };

  return {
    hydrate: vi.fn(async () => {}),
    retryDeferred: vi.fn(async () => {}),
    getState: () => state,
    refresh: vi.fn(async () => {}),
    getEvents: () => events,
    getSourceStatus: () => status,
    get sourceStatus() {
      return status;
    },
    getCalendars: (id) => calendars[id] ?? [],
    getSelectedIds: (id) => selected[id] ?? [],
    setSelectedIds: vi.fn(setSelected),
    clearSelectedIds: vi.fn((id: string) =>
      setSelected(id, [(calendars[id] ?? []).find((c) => c.primary)?.id ?? 'primary']),
    ),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Legacy (notesdiary) prop names, mapped onto the package's props/controller. */
export interface PaneTestOverrides {
  events?: CalendarEvent[];
  loading?: boolean;
  error?: boolean;
  connected?: boolean;
  needsReauth?: boolean;
  onConnect?: () => void;
  onReconnect?: () => void;
  selectedRsvpStatuses?: RsvpSelection;
  onRsvpStatusesChange?: (next: RsvpSelection) => void;
  calendars?: CalendarInfo[];
  selectedCalendarIds?: string[];
  onCalendarSelectionChange?: (nextIds: string[]) => void;
  onClose?: () => void;
  canInsertCalendarEventLink?: boolean;
  onInsertCalendarEventLink?: (title: string, url: string) => void;
}

function usableUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const t = url.trim();
  return t === '' ? null : t;
}

/** Host-owned "insert link" action, rendered through the renderEventAction slot. */
function InsertLinkAction({ title, url, onInsert }: { title: string; url: string; onInsert: (t: string, u: string) => void }) {
  const label = `Insert "${title}" link into note`;
  return (
    <button type="button" data-calendar-insert-link aria-label={label} title={label} onClick={() => onInsert(title, url)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M10 13a5 5 0 0 0 7.07 0l3-3" stroke="currentColor" strokeWidth="2" />
      </svg>
    </button>
  );
}

/** Builds CalendarPane props (sources, controller, slots) from the legacy prop shape. */
export function baseProps(o: PaneTestOverrides = {}) {
  const connected = o.connected ?? true;
  const sources: Source[] = connected ? [SOURCE] : [];
  const controller = createFakeController({
    sources,
    events: o.events ?? [],
    status: { [SOURCE.id]: o.needsReauth ? 'needs-scope' : o.error ? 'error' : 'ok' },
    calendars: { [SOURCE.id]: o.calendars ?? [] },
    selected: { [SOURCE.id]: o.selectedCalendarIds ?? [] },
  });
  if (o.onCalendarSelectionChange) {
    const onChange = o.onCalendarSelectionChange;
    controller.setSelectedIds = vi.fn(async (_id: string, ids: string[]) => onChange(ids));
  }
  const canInsert = o.canInsertCalendarEventLink && o.onInsertCalendarEventLink;
  const onInsert = o.onInsertCalendarEventLink;
  return {
    sources,
    controller,
    selectedRsvpStatuses: o.selectedRsvpStatuses ?? (new Set(DEFAULT_RSVP_STATUSES) as RsvpSelection),
    onRsvpStatusesChange: o.onRsvpStatusesChange ?? vi.fn(),
    onClose: o.onClose,
    emptyState: (
      <div>
        <p>Not connected to Google Calendar.</p>
        <button className="calendar-connect-button" onClick={o.onConnect}>
          Connect Google Calendar
        </button>
      </div>
    ) as ReactNode,
    sourceNotice: () => (
      <div>
        <p>Calendar connection needs reauthorization.</p>
        <button className="calendar-connect-button" onClick={o.onReconnect}>
          Reconnect to restore sync
        </button>
      </div>
    ),
    renderEventAction: canInsert
      ? (event: CalendarEvent) => {
          const url = usableUrl(event.htmlLink);
          return url ? <InsertLinkAction title={event.summary} url={url} onInsert={onInsert!} /> : null;
        }
      : undefined,
  };
}
