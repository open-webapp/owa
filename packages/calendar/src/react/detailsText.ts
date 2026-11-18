export type Token = { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

const BLOCK = 'p,div,li,tr,h1,h2,h3,h4,h5,h6,ul,ol,blockquote';

export function htmlToPlainText(html?: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style').forEach((n) => n.remove());
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  doc.querySelectorAll(BLOCK).forEach((n) => n.append('\n'));
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

export function linkifyText(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /https?:\/\/[^\s<>"]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const url = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
    if (m.index > last) tokens.push({ type: 'text', text: text.slice(last, m.index) });
    tokens.push({ type: 'link', text: url, href: url });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  return tokens;
}

function timeOfDay(dateTime: string): string {
  return new Date(dateTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
}

export function formatEventWhen(
  start?: string,
  end?: string,
  allDay?: boolean,
): { date: string; time: string } {
  if (!start) return { date: '', time: '' };
  const d = allDay ? parseLocalDate(start) : new Date(start);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (allDay) return { date, time: '' };
  const s = timeOfDay(start);
  return { date, time: end ? `${s} – ${timeOfDay(end)}` : s };
}
