process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';
import { htmlToPlainText, linkifyText, formatEventWhen } from '../detailsText.js';

describe('htmlToPlainText', () => {
  it('converts br and strips tags', () => {
    expect(htmlToPlainText('<b>Hi</b><br>x')).toBe('Hi\nx');
  });
  it('decodes entities', () => {
    expect(htmlToPlainText('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
  });
  it('drops script contents', () => {
    expect(htmlToPlainText('a<script>alert(1)</script>b')).toBe('ab');
  });
  it('breaks on block elements', () => {
    expect(htmlToPlainText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });
  it('empty/undefined -> empty', () => {
    expect(htmlToPlainText(undefined)).toBe('');
    expect(htmlToPlainText('')).toBe('');
  });
});

describe('linkifyText', () => {
  it('splits text and link', () => {
    expect(linkifyText('see https://a.com')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'https://a.com', href: 'https://a.com' },
    ]);
  });
  it('does not link javascript:', () => {
    expect(linkifyText('javascript:alert(1)')).toEqual([{ type: 'text', text: 'javascript:alert(1)' }]);
  });
  it('excludes trailing punctuation', () => {
    expect(linkifyText('https://a.com.')).toEqual([
      { type: 'link', text: 'https://a.com', href: 'https://a.com' },
      { type: 'text', text: '.' },
    ]);
  });
  it('empty -> no tokens', () => {
    expect(linkifyText('')).toEqual([]);
  });
});

describe('formatEventWhen', () => {
  it('uses local date (LA) for timed event', () => {
    const r = formatEventWhen('2026-03-02T06:30:00Z', '2026-03-02T07:30:00Z', false);
    expect(r.date).toBe('Mar 1');
    expect(r.time).toBe('10:30 PM – 11:30 PM');
  });
  it('all-day has no time', () => {
    expect(formatEventWhen('2026-03-02', undefined, true)).toEqual({ date: 'Mar 2', time: '' });
  });
  it('empty start -> empty', () => {
    expect(formatEventWhen(undefined, undefined, false)).toEqual({ date: '', time: '' });
  });
});
