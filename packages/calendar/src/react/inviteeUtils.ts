import type { CalendarEventAttendee } from '../core/types.js';

type Bucket = 'accepted' | 'tentative' | 'needsAction' | 'declined';
const ORDER: Bucket[] = ['accepted', 'tentative', 'needsAction', 'declined'];
const LABELS: Record<Bucket, string> = { accepted: 'yes', tentative: 'maybe', needsAction: 'awaiting', declined: 'no' };

function bucketOf(status: unknown): Bucket {
  return ORDER.includes(status as Bucket) ? (status as Bucket) : 'needsAction';
}

function nameOf(a: CalendarEventAttendee): string {
  return (a.displayName || a.email || '').toLowerCase();
}

function rank(a: CalendarEventAttendee): number {
  if (a.organizer) return 0;
  if (a.self) return 1;
  return 2 + ORDER.indexOf(bucketOf(a.responseStatus));
}

export function sortInvitees(attendees: CalendarEventAttendee[]): CalendarEventAttendee[] {
  return [...attendees].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const n = nameOf(a).localeCompare(nameOf(b));
    return n !== 0 ? n : (a.email || '').toLowerCase().localeCompare((b.email || '').toLowerCase());
  });
}

export function summarizeInvitees(attendees: CalendarEventAttendee[]): string {
  const counts: Record<Bucket, number> = { accepted: 0, tentative: 0, needsAction: 0, declined: 0 };
  for (const a of attendees) counts[bucketOf(a.responseStatus)]++;
  return ORDER.filter((b) => counts[b] > 0).map((b) => `${counts[b]} ${LABELS[b]}`).join(' · ');
}
