import { describe, it, expect } from 'vitest';
import {
  splitParts,
  splitSections,
  extractTags,
  isTagOnlySection,
  getEntryLevelTags,
  isValidCalendarDate,
  findAcceptedDateToken,
  parseSectionDate,
  splitPartsWithDate,
  resolveSectionDates,
  AlreadyEmitted,
  getExplicitSectionDate,
  getEntryLevelDate,
  listAutocompleteTags,
} from '../tags.js';

describe('tags', () => {
  describe('splitParts', () => {
    it('splits text with one tag', () => {
      const result = splitParts('hi #foo bar');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: 'hi ', isTag: false });
      expect(result[1]).toEqual({ text: '#foo', isTag: true });
      expect(result[2]).toEqual({ text: ' bar', isTag: false });
    });

    it('matches a tag starting with a digit', () => {
      const result = splitParts('#3d is a tag now');
      expect(result[0]).toEqual({ text: '#3d', isTag: true });
    });

    it('matches a purely numeric tag (#42 done)', () => {
      const result = splitParts('#42 done');
      expect(result).toEqual([
        { text: '#42', isTag: true },
        { text: ' done', isTag: false },
      ]);
    });

    it('matches a year-like numeric tag (#2024)', () => {
      const result = splitParts('year #2024 recap');
      expect(result).toContainEqual({ text: '#2024', isTag: true });
    });

    it('treats a colon as a literal char in a flat tag (#1:1)', () => {
      const result = splitParts('had a #1:1 today');
      const tagParts = result.filter(p => p.isTag);
      expect(tagParts).toHaveLength(1);
      expect(tagParts[0].text).toBe('#1:1');
    });

    it('matches multiple colon groups (#a:b:c)', () => {
      const result = splitParts('#a:b:c note');
      expect(result).toContainEqual({ text: '#a:b:c', isTag: true });
    });

    it('matches a colon group after a digit-containing first segment (#q3:review)', () => {
      const result = splitParts('#q3:review');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: '#q3:review', isTag: true });
    });

    it('does not match a tag whose first char is a colon (#:x)', () => {
      const result = splitParts('#:x');
      expect(result).toEqual([{ text: '#:x', isTag: false }]);
    });

    it('does not consume a dangling colon (#x: end)', () => {
      const result = splitParts('#x: end');
      expect(result).toEqual([
        { text: '#x', isTag: true },
        { text: ': end', isTag: false },
      ]);
    });

    it('does not consume a double-colon run (#a::b)', () => {
      const result = splitParts('#a::b');
      expect(result).toEqual([
        { text: '#a', isTag: true },
        { text: '::b', isTag: false },
      ]);
    });

    it('combines colon groups with a /child continuation (#1:1/foo)', () => {
      const result = splitParts('note #1:1/foo here');
      expect(result).toContainEqual({ text: '#1:1/foo', isTag: true });
    });

    it('does not widen the /child segment for colon/digit (#work/1:1)', () => {
      const result = splitParts('do #work/1:1 sync');
      expect(result).toEqual([
        { text: 'do ', isTag: false },
        { text: '#work', isTag: true },
        { text: '/1:1 sync', isTag: false },
      ]);
    });

    it('matches tag with hyphens and underscores', () => {
      const result = splitParts('#a-b_c');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: '#a-b_c', isTag: true });
    });

    it('handles multiple tags', () => {
      const result = splitParts('hello #tag1 world #tag2');
      expect(result).toHaveLength(4);
      expect(result.filter(p => p.isTag)).toHaveLength(2);
      expect(result.filter(p => !p.isTag)).toHaveLength(2);
    });

    it('handles tag at start of text', () => {
      const result = splitParts('#start of text');
      expect(result[0]).toEqual({ text: '#start', isTag: true });
    });

    it('handles tag at end of text', () => {
      const result = splitParts('end of #text');
      const lastPart = result[result.length - 1];
      expect(lastPart).toEqual({ text: '#text', isTag: true });
    });

    it('handles consecutive tags', () => {
      const result = splitParts('#tag1#tag2');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#tag1', isTag: true });
      expect(result[1]).toEqual({ text: '#tag2', isTag: true });
    });

    it('returns single non-tag part for text with no tags', () => {
      const result = splitParts('plain text');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: 'plain text', isTag: false });
    });

    it('parses one level of nested tag as a single tag part', () => {
      const result = splitParts('note #work/urgent today');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: 'note ', isTag: false });
      expect(result[1]).toEqual({ text: '#work/urgent', isTag: true });
      expect(result[2]).toEqual({ text: ' today', isTag: false });
    });

    it('parses plain flat tag unaffected by nesting support', () => {
      const result = splitParts('#work');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: '#work', isTag: true });
    });

    it('only nests one level deep (#a/b/c)', () => {
      const result = splitParts('#a/b/c');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#a/b', isTag: true });
      expect(result[1]).toEqual({ text: '/c', isTag: false });
    });

    it('handles dangling slash at end of string (#tag/)', () => {
      const result = splitParts('#tag/');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#tag', isTag: true });
      expect(result[1]).toEqual({ text: '/', isTag: false });
    });

    it('handles dangling slash mid-sentence (#tag/ more text)', () => {
      const result = splitParts('#tag/ more text');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#tag', isTag: true });
      expect(result[1]).toEqual({ text: '/ more text', isTag: false });
    });

    it('does not nest into a digit after the slash (#tag/123)', () => {
      const result = splitParts('#tag/123');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#tag', isTag: true });
      expect(result[1]).toEqual({ text: '/123', isTag: false });
    });

    it('does not nest when a space separates tag from slash (#work /urgent)', () => {
      const result = splitParts('#work /urgent');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#work', isTag: true });
      expect(result[1]).toEqual({ text: ' /urgent', isTag: false });
    });
  });

  describe('splitSections', () => {
    it('single line, no breaks', () => {
      const result = splitSections('single line');
      expect(result).toEqual(['single line']);
    });

    it('two lines with single newline stay one section with break preserved', () => {
      const result = splitSections('line1\nline2');
      expect(result).toEqual(['line1\nline2']);
    });

    it('blank-line-separated paragraphs become separate sections', () => {
      const result = splitSections('para1\n\npara2');
      expect(result).toEqual(['para1', 'para2']);
    });

    it('multiple blank lines collapse to single boundary', () => {
      const result = splitSections('para1\n\n\n\npara2');
      expect(result).toEqual(['para1', 'para2']);
    });

    it('leading and trailing blank lines are trimmed', () => {
      const result = splitSections('\n\npara1\n\n');
      expect(result).toEqual(['para1']);
    });

    it('section with internal line breaks plus blank-line-separated section', () => {
      const result = splitSections('line1\nline2\n\npara2');
      expect(result).toEqual(['line1\nline2', 'para2']);
    });

    it('all-whitespace and empty input return empty array', () => {
      expect(splitSections('')).toEqual([]);
      expect(splitSections('   \n\n   ')).toEqual([]);
    });

    it('three-section entry mixing single breaks and paragraph breaks', () => {
      const result = splitSections('a\nb\n\nc\n\n\nd\ne\nf');
      expect(result).toEqual(['a\nb', 'c', 'd\ne\nf']);
    });
  });

  describe('extractTags', () => {
    it('extracts tags from text', () => {
      const result = extractTags('hello #foo #bar world');
      expect(result).toEqual(['#foo', '#bar']);
    });

    it('returns empty array for text with no tags', () => {
      const result = extractTags('plain text');
      expect(result).toEqual([]);
    });

    it('handles multiple occurrences of same tag', () => {
      const result = extractTags('#tag #tag');
      expect(result).toEqual(['#tag', '#tag']);
    });

    it('extracts colon and numeric tags in order', () => {
      const result = extractTags('#1:1 and #q3:review and #42');
      expect(result).toEqual(['#1:1', '#q3:review', '#42']);
    });
  });

  describe('listAutocompleteTags', () => {
    it('returns sorted unique tags and matches prefixes case-insensitively', () => {
      const entries = [
        { id: 'a', text: 'a #beta #alpha' },
        { id: 'b', text: 'b #alpha' },
      ];

      expect(listAutocompleteTags(entries, '')).toEqual(['alpha', 'beta']);
      expect(listAutocompleteTags(entries, 'BE')).toEqual(['beta']);
    });

    it('excludes archived entries and does not synthesize untagged', () => {
      const entries = [
        { id: 'a', text: '#active' },
        { id: 'b', text: '#archived', archived: true },
        { id: 'c', text: 'untagged entry' },
      ];

      expect(listAutocompleteTags(entries, '')).toEqual(['active']);
    });

    it('keeps complete colon, slash, and digit-leading tag names', () => {
      const entries = [
        { id: 'a', text: '#a:b #a/c #2fa' },
      ];

      expect(listAutocompleteTags(entries, '')).toEqual(['2fa', 'a/c', 'a:b']);
    });

    it('returns no suggestions for empty input or a non-matching prefix', () => {
      expect(listAutocompleteTags([], '')).toEqual([]);
      expect(listAutocompleteTags([{ id: 'a', text: '#alpha' }], 'beta')).toEqual([]);
    });

    it('ignores empty or whitespace entry text', () => {
      const entries = [
        { id: 'a', text: '' },
        { id: 'b', text: '   ' },
      ];

      expect(listAutocompleteTags(entries, '')).toEqual([]);
    });
  });

  describe('isTagOnlySection', () => {
    it('returns true for tags only', () => {
      const result = isTagOnlySection('#work #urgent');
      expect(result).toBe(true);
    });

    it('returns false for tags mixed with prose', () => {
      const result = isTagOnlySection('#work urgent stuff');
      expect(result).toBe(false);
    });

    it('returns false for tags separated by punctuation', () => {
      const result = isTagOnlySection('#work, #urgent');
      expect(result).toBe(false);
    });

    it('returns true for empty string', () => {
      const result = isTagOnlySection('');
      expect(result).toBe(true);
    });

    it('returns true for whitespace only', () => {
      const result = isTagOnlySection('   ');
      expect(result).toBe(true);
    });

    it('returns true for tags separated by newlines', () => {
      const result = isTagOnlySection('#work\n#urgent');
      expect(result).toBe(true);
    });

    // Regression: a trailing line combining a tag with a date token (e.g.
    // "#work @2024-01-15") carries no prose of its own, so it should count
    // as tag-only same as a bare "#work" line.
    it('returns true for a tag combined with a date token', () => {
      const result = isTagOnlySection('#work @2024-01-15');
      expect(result).toBe(true);
    });

    it('returns false for a tag, a date token, and prose', () => {
      const result = isTagOnlySection('#work @2024-01-15 meeting notes');
      expect(result).toBe(false);
    });

    it('returns true for colon and numeric tags only', () => {
      const result = isTagOnlySection('#1:1 #42');
      expect(result).toBe(true);
    });

    it('returns false for a colon tag mixed with prose', () => {
      const result = isTagOnlySection('#1:1 recap notes');
      expect(result).toBe(false);
    });

    it('returns false for a tag followed by a dangling colon and prose', () => {
      const result = isTagOnlySection('#x: leftover');
      expect(result).toBe(false);
    });
  });

  describe('getEntryLevelTags', () => {
    it('returns tags from trailing tag-only section', () => {
      const result = getEntryLevelTags('line one\n\n#work #urgent');
      expect(result).toEqual(['#work', '#urgent']);
    });

    it('returns empty array when tag-only section is not last', () => {
      const result = getEntryLevelTags('#work #urgent\n\nline one');
      expect(result).toEqual([]);
    });

    it('returns tags from single-section entry', () => {
      const result = getEntryLevelTags('#work #urgent');
      expect(result).toEqual(['#work', '#urgent']);
    });

    it('returns empty array for entry with no tags', () => {
      const result = getEntryLevelTags('just prose, no tags');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      const result = getEntryLevelTags('');
      expect(result).toEqual([]);
    });

    it('returns empty array when last section has mixed tag and text', () => {
      const result = getEntryLevelTags('line\n\n#work and more text');
      expect(result).toEqual([]);
    });

    it('handles multiple tags with various spacing', () => {
      const result = getEntryLevelTags('content\n\n#a #b  #c   #d');
      expect(result).toEqual(['#a', '#b', '#c', '#d']);
    });

    it('returns colon tags from trailing tag-only section', () => {
      const result = getEntryLevelTags('body text\n\n#1:1 #q3:review');
      expect(result).toEqual(['#1:1', '#q3:review']);
    });
  });

  describe('isValidCalendarDate', () => {
    it('returns true for valid leap year date', () => {
      expect(isValidCalendarDate(2026, 2, 28)).toBe(true);
    });

    it('returns false for Feb 29 in non-leap year', () => {
      expect(isValidCalendarDate(2026, 2, 29)).toBe(false);
    });

    it('returns true for Feb 29 in leap year', () => {
      expect(isValidCalendarDate(2024, 2, 29)).toBe(true);
    });

    it('returns false for Feb 30', () => {
      expect(isValidCalendarDate(2026, 2, 30)).toBe(false);
    });

    it('returns false for month 13', () => {
      expect(isValidCalendarDate(2026, 13, 5)).toBe(false);
    });

    it('returns false for month 0', () => {
      expect(isValidCalendarDate(2026, 0, 5)).toBe(false);
    });

    it('returns false for day 0', () => {
      expect(isValidCalendarDate(2026, 1, 0)).toBe(false);
    });

    it('returns false for day 32 in 31-day month', () => {
      expect(isValidCalendarDate(2026, 1, 32)).toBe(false);
    });

    it('returns false for day 31 in 30-day month', () => {
      expect(isValidCalendarDate(2026, 4, 31)).toBe(false);
    });

    it('returns true for Jan 1', () => {
      expect(isValidCalendarDate(2026, 1, 1)).toBe(true);
    });

    it('returns true for Dec 31', () => {
      expect(isValidCalendarDate(2026, 12, 31)).toBe(true);
    });
  });

  describe('findAcceptedDateToken', () => {
    it('finds valid date in middle of text', () => {
      const result = findAcceptedDateToken('meeting @2026-01-05 notes');
      expect(result).toEqual({
        index: 8,
        raw: '@2026-01-05',
        iso: '2026-01-05',
      });
    });

    it('finds date at start of text', () => {
      const result = findAcceptedDateToken('@2026-01-05');
      expect(result).toEqual({
        index: 0,
        raw: '@2026-01-05',
        iso: '2026-01-05',
      });
    });

    it('returns null when no date present', () => {
      const result = findAcceptedDateToken('no date here');
      expect(result).toBeNull();
    });

    it('returns null for invalid month', () => {
      const result = findAcceptedDateToken('@2026-13-45');
      expect(result).toBeNull();
    });

    it('returns null for invalid day', () => {
      const result = findAcceptedDateToken('@2026-02-30');
      expect(result).toBeNull();
    });

    it('returns first valid date when multiple present', () => {
      const result = findAcceptedDateToken('@2026-01-05 and @2026-02-10');
      expect(result).toEqual({
        index: 0,
        raw: '@2026-01-05',
        iso: '2026-01-05',
      });
    });

    it('skips invalid dates and returns first valid', () => {
      const result = findAcceptedDateToken('@2026-13-45 then @2026-01-05');
      expect(result).toEqual({
        index: 17,
        raw: '@2026-01-05',
        iso: '2026-01-05',
      });
    });

    it('requires whitespace or start before @ (rejects foo@2026-01-05)', () => {
      const result = findAcceptedDateToken('foo@2026-01-05');
      expect(result).toBeNull();
    });

    it('rejects date followed by digit (@2026-01-051)', () => {
      const result = findAcceptedDateToken('@2026-01-051');
      expect(result).toBeNull();
    });

    it('accepts flexible format (@2026-1-5)', () => {
      const result = findAcceptedDateToken('@2026-1-5');
      expect(result).toEqual({
        index: 0,
        raw: '@2026-1-5',
        iso: '2026-01-05',
      });
    });

    it('accepts date at end of text', () => {
      const result = findAcceptedDateToken('meeting on @2026-01-05');
      expect(result).toEqual({
        index: 11,
        raw: '@2026-01-05',
        iso: '2026-01-05',
      });
    });

    it('accepts US format (@08-17-2026)', () => {
      const result = findAcceptedDateToken('@08-17-2026');
      expect(result).toEqual({
        index: 0,
        raw: '@08-17-2026',
        iso: '2026-08-17',
      });
    });

    it('accepts slash separator (@2026/08/17)', () => {
      const result = findAcceptedDateToken('@2026/08/17');
      expect(result).toEqual({
        index: 0,
        raw: '@2026/08/17',
        iso: '2026-08-17',
      });
    });

    it('rejects format without 4-digit year (@8/17)', () => {
      const result = findAcceptedDateToken('@8/17');
      expect(result).toBeNull();
    });

    it('first-wins across formats (@08-17-2026 then @2026-01-05)', () => {
      const result = findAcceptedDateToken('@08-17-2026 then @2026-01-05');
      expect(result).toEqual({
        index: 0,
        raw: '@08-17-2026',
        iso: '2026-08-17',
      });
    });

    it('skips invalid date and returns first valid (@2026-02-30 then @2026-01-05)', () => {
      const result = findAcceptedDateToken('@2026-02-30 then @2026-01-05');
      expect(result).toEqual({
        index: 17,
        raw: '@2026-01-05',
        iso: '2026-01-05',
      });
    });
  });

  describe('parseSectionDate', () => {
    it('returns ISO date for text with valid date', () => {
      const result = parseSectionDate('meeting @2026-01-05 notes');
      expect(result).toBe('2026-01-05');
    });

    it('returns ISO date for bare date', () => {
      const result = parseSectionDate('@2026-01-05');
      expect(result).toBe('2026-01-05');
    });

    it('returns null for text without date', () => {
      const result = parseSectionDate('no date');
      expect(result).toBeNull();
    });

    it('returns null for invalid calendar date', () => {
      const result = parseSectionDate('@2026-13-45');
      expect(result).toBeNull();
    });

    it('returns null for Feb 30', () => {
      const result = parseSectionDate('@2026-02-30');
      expect(result).toBeNull();
    });

    it('returns first valid date when multiple present', () => {
      const result = parseSectionDate('@2026-01-05 and @2026-02-10');
      expect(result).toBe('2026-01-05');
    });

    it('skips invalid and returns first valid date', () => {
      const result = parseSectionDate('@2026-13-45 then @2026-01-05');
      expect(result).toBe('2026-01-05');
    });

    it('returns null for date missing boundary (foo@2026-01-05)', () => {
      const result = parseSectionDate('foo@2026-01-05');
      expect(result).toBeNull();
    });

    it('returns null for date with trailing digit (@2026-01-051)', () => {
      const result = parseSectionDate('@2026-01-051');
      expect(result).toBeNull();
    });

    it('accepts flexible format (@2026-1-5)', () => {
      const result = parseSectionDate('@2026-1-5');
      expect(result).toBe('2026-01-05');
    });

    it('accepts US format (@08-17-2026)', () => {
      const result = parseSectionDate('@08-17-2026');
      expect(result).toBe('2026-08-17');
    });

    it('first-wins across formats (@08-17-2026 then @2026-01-05)', () => {
      const result = parseSectionDate('@08-17-2026 then @2026-01-05');
      expect(result).toBe('2026-08-17');
    });

    it('invalid-first, valid-second returns first valid (@2026-02-30 then @2026-01-05)', () => {
      const result = parseSectionDate('@2026-02-30 then @2026-01-05');
      expect(result).toBe('2026-01-05');
    });
  });

  describe('resolveSectionDates', () => {
    it('returns just the entry date when no explicit token present', () => {
      const result = resolveSectionDates('plain note', '2026-08-15');
      expect(result).toEqual(['2026-08-15']);
    });

    it('includes both entry date and explicit token date when they differ', () => {
      const result = resolveSectionDates('meet @2026-01-05', '2026-08-15');
      expect(result).toHaveLength(2);
      expect(result).toContain('2026-08-15');
      expect(result).toContain('2026-01-05');
    });

    it('dedupes when explicit token equals entry date', () => {
      const result = resolveSectionDates('meet @2026-08-15', '2026-08-15');
      expect(result).toEqual(['2026-08-15']);
      expect(result).toHaveLength(1);
    });

    it('ignores an invalid explicit token', () => {
      const result = resolveSectionDates('bad @2026-13-45', '2026-08-15');
      expect(result).toEqual(['2026-08-15']);
    });

    it('only includes the first-wins token when two valid explicit tokens present', () => {
      const result = resolveSectionDates('@2026-01-05 and @2026-02-10', '2026-08-15');
      expect(result).toHaveLength(2);
      expect(result).toContain('2026-08-15');
      expect(result).toContain('2026-01-05');
      expect(result).not.toContain('2026-02-10');
    });
  });

  describe('resolveSectionDates regression checks', () => {
    it('splitPartsWithDate still marks only the first token as isDate:true', () => {
      const result = splitPartsWithDate('@2026-01-05 and @2026-02-10', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[1]).toEqual({ text: ' and ', isTag: false });
      expect(result[2]).toEqual({ text: '@2026-02-10', isTag: false });
    });

    it('parseSectionDate still returns the first-wins value', () => {
      expect(parseSectionDate('@2026-01-05 and @2026-02-10')).toBe('2026-01-05');
    });
  });

  describe('splitPartsWithDate', () => {
    it('marks matching date with isDate:true and date field', () => {
      const result = splitPartsWithDate('note @2026-01-05 done', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: 'note ', isTag: false });
      expect(result[1]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[2]).toEqual({ text: ' done', isTag: false });
    });

    it('treats date as plain text when acceptedIso is null', () => {
      const result = splitPartsWithDate('@2026-01-05', null);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: '@2026-01-05', isTag: false });
    });

    it('ignores non-matching date tokens', () => {
      const result = splitPartsWithDate('@2026-02-10', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: '@2026-02-10', isTag: false });
    });

    it('marks first matching date when multiple different dates present', () => {
      const result = splitPartsWithDate('@2026-01-05 and @2026-02-10', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[1]).toEqual({ text: ' and ', isTag: false });
      expect(result[2]).toEqual({ text: '@2026-02-10', isTag: false });
    });

    it('marks first matching date when same date appears multiple times', () => {
      const result = splitPartsWithDate('@2026-01-05 and @2026-01-05', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[1]).toEqual({ text: ' and ', isTag: false });
      expect(result[2]).toEqual({ text: '@2026-01-05', isTag: false });
      expect(result[2].isDate).toBeUndefined();
      expect(result[2].date).toBeUndefined();
    });

    it('shares emitted flag across multiple calls', () => {
      const state: AlreadyEmitted = { done: false };
      const result1 = splitPartsWithDate('@2026-01-05 text', '2026-01-05', state);
      expect(result1[0]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(state.done).toBe(true);

      // Now call again with same state
      const result2 = splitPartsWithDate('@2026-01-05 more', '2026-01-05', state);
      expect(result2[0]).toEqual({ text: '@2026-01-05', isTag: false });
      expect(result2[0].isDate).toBeUndefined();
      expect(result2[0].date).toBeUndefined();
    });

    it('maintains splitParts behavior - tags unchanged', () => {
      const result = splitParts('hi #foo bar');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: 'hi ', isTag: false });
      expect(result[1]).toEqual({ text: '#foo', isTag: true });
      expect(result[2]).toEqual({ text: ' bar', isTag: false });
    });

    it('handles date and tags together', () => {
      const result = splitPartsWithDate('note @2026-01-05 #work done', '2026-01-05');
      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({ text: 'note ', isTag: false });
      expect(result[1]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[2]).toEqual({ text: ' ', isTag: false });
      expect(result[3]).toEqual({ text: '#work', isTag: true });
      expect(result[4]).toEqual({ text: ' done', isTag: false });
    });

    it('handles tags before and after marked date', () => {
      const result = splitPartsWithDate('#start @2026-01-05 #end', '2026-01-05');
      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({ text: '#start', isTag: true });
      expect(result[1]).toEqual({ text: ' ', isTag: false });
      expect(result[2]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[3]).toEqual({ text: ' ', isTag: false });
      expect(result[4]).toEqual({ text: '#end', isTag: true });
    });

    it('extracts invalid date tokens with isInvalidDate and marks valid matching dates', () => {
      const result = splitPartsWithDate('@2026-13-45 real @2026-01-05', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: '@2026-13-45', isTag: false, isInvalidDate: true });
      expect(result[1]).toEqual({ text: ' real ', isTag: false });
      expect(result[2]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
    });

    it('date at start of text', () => {
      const result = splitPartsWithDate('@2026-01-05 start', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[1]).toEqual({ text: ' start', isTag: false });
    });

    it('date at end of text', () => {
      const result = splitPartsWithDate('end @2026-01-05', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: 'end ', isTag: false });
      expect(result[1]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
    });

    it('handles only tags, no dates', () => {
      const result = splitPartsWithDate('#tag1 #tag2', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: '#tag1', isTag: true });
      expect(result[1]).toEqual({ text: ' ', isTag: false });
      expect(result[2]).toEqual({ text: '#tag2', isTag: true });
    });

    it('handles plain text with no dates or tags', () => {
      const result = splitPartsWithDate('plain text', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: 'plain text', isTag: false });
    });

    it('date at start requires whitespace or string start', () => {
      // foo@2026-01-05 should not match due to missing word boundary
      const result = splitPartsWithDate('foo@2026-01-05', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: 'foo@2026-01-05', isTag: false });
    });

    it('does not mark date from a different iso value in text', () => {
      const result = splitPartsWithDate('has @2026-02-10', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: 'has ', isTag: false });
      expect(result[1]).toEqual({ text: '@2026-02-10', isTag: false });
      expect(result[1].isDate).toBeUndefined();
      expect(result[1].date).toBeUndefined();
    });

    it('marks invalid date token with isInvalidDate:true (@2026-02-30)', () => {
      const result = splitPartsWithDate('@2026-02-30', null);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        text: '@2026-02-30',
        isTag: false,
        isInvalidDate: true,
      });
    });

    it('handles invalid date + valid date (@2026-02-30 and @2026-01-05)', () => {
      const result = splitPartsWithDate('@2026-02-30 and @2026-01-05', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        text: '@2026-02-30',
        isTag: false,
        isInvalidDate: true,
      });
      expect(result[1]).toEqual({ text: ' and ', isTag: false });
      expect(result[2]).toEqual({
        text: '@2026-01-05',
        isTag: false,
        isDate: true,
        date: '2026-01-05',
      });
    });

    it('second valid date stays plain (no isInvalidDate, no isDate)', () => {
      const result = splitPartsWithDate('@2026-01-05 and @2026-02-10', '2026-01-05');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        text: '@2026-01-05',
        isTag: false,
        isDate: true,
        date: '2026-01-05',
      });
      expect(result[1]).toEqual({ text: ' and ', isTag: false });
      expect(result[2]).toEqual({
        text: '@2026-02-10',
        isTag: false,
      });
      expect(result[2].isDate).toBeUndefined();
      expect(result[2].isInvalidDate).toBeUndefined();
    });

    it('accepts flexible date formats', () => {
      const result = splitPartsWithDate('@08-17-2026', '2026-08-17');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        text: '@08-17-2026',
        isTag: false,
        isDate: true,
        date: '2026-08-17',
      });
    });

    it('accepts slash-separated dates', () => {
      const result = splitPartsWithDate('@2026/08/17', '2026-08-17');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        text: '@2026/08/17',
        isTag: false,
        isDate: true,
        date: '2026-08-17',
      });
    });

    it('parses one level of nested tag as a single tag part', () => {
      const result = splitPartsWithDate('note #work/urgent @2026-01-05', '2026-01-05');
      expect(result[1]).toEqual({ text: '#work/urgent', isTag: true });
    });

    it('parses plain flat tag unaffected by nesting support', () => {
      const result = splitPartsWithDate('#work @2026-01-05', '2026-01-05');
      expect(result[0]).toEqual({ text: '#work', isTag: true });
    });

    it('only nests one level deep (#a/b/c)', () => {
      const result = splitPartsWithDate('#a/b/c', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#a/b', isTag: true });
      expect(result[1]).toEqual({ text: '/c', isTag: false });
    });

    it('handles dangling slash at end of string (#tag/)', () => {
      const result = splitPartsWithDate('#tag/', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: '#tag', isTag: true });
      expect(result[1]).toEqual({ text: '/', isTag: false });
    });

    it('handles dangling slash mid-sentence (#tag/ more text)', () => {
      const result = splitPartsWithDate('#tag/ more text', '2026-01-05');
      expect(result[0]).toEqual({ text: '#tag', isTag: true });
      expect(result[1]).toEqual({ text: '/ more text', isTag: false });
    });

    it('does not nest into a digit after the slash (#tag/123)', () => {
      const result = splitPartsWithDate('#tag/123', '2026-01-05');
      expect(result[0]).toEqual({ text: '#tag', isTag: true });
      expect(result[1]).toEqual({ text: '/123', isTag: false });
    });

    it('does not nest when a space separates tag from slash (#work /urgent)', () => {
      const result = splitPartsWithDate('#work /urgent', '2026-01-05');
      expect(result[0]).toEqual({ text: '#work', isTag: true });
      expect(result[1]).toEqual({ text: ' /urgent', isTag: false });
    });

    it('keeps a colon tag before a marked date (#1:1 @2026-01-05 sync)', () => {
      const result = splitPartsWithDate('#1:1 @2026-01-05 sync', '2026-01-05');
      expect(result[0]).toEqual({ text: '#1:1', isTag: true });
      expect(result[1]).toEqual({ text: ' ', isTag: false });
      expect(result[2]).toEqual({ text: '@2026-01-05', isTag: false, isDate: true, date: '2026-01-05' });
      expect(result[3]).toEqual({ text: ' sync', isTag: false });
    });
  });

  describe('getExplicitSectionDate', () => {
    it('returns the ISO date for a section with a valid date token', () => {
      expect(getExplicitSectionDate('meet @2026-01-05')).toBe('2026-01-05');
    });

    it('returns null when there is no date token', () => {
      expect(getExplicitSectionDate('no date here')).toBe(null);
    });

    it('returns null for an invalid calendar date', () => {
      expect(getExplicitSectionDate('bad @2026-13-45')).toBe(null);
    });

    it('matches parseSectionDate for the same input (no drift)', () => {
      const fixtures = [
        'meet @2026-01-05',
        'no date here',
        'bad @2026-13-45',
        '#work @2026-01-05',
        'multiple @2026-01-05 and @2026-02-10',
        '@01-05-2026 mm-dd-yyyy style',
      ];
      for (const section of fixtures) {
        expect(getExplicitSectionDate(section)).toBe(parseSectionDate(section));
      }
    });
  });

  describe('getEntryLevelDate', () => {
    it('returns the date for a date-only trailing section', () => {
      expect(getEntryLevelDate('note\n\n@2026-01-05')).toBe('2026-01-05');
    });

    it('returns the date for a tag+date trailing section', () => {
      expect(getEntryLevelDate('note\n\n#work @2026-01-05')).toBe('2026-01-05');
    });

    it('returns null when trailing section has a tag but no date', () => {
      expect(getEntryLevelDate('note\n\n#work')).toBe(null);
    });

    it('returns null when the last section is not metadata-only', () => {
      expect(getEntryLevelDate('note @2026-01-05\n\nmore text')).toBe(null);
    });

    it('returns null for a single non-metadata section (no section separators)', () => {
      // splitSections returns one section for a plain single-paragraph
      // string with no blank-line separators; it's null here because that
      // section contains real prose, not because there are zero sections.
      expect(getEntryLevelDate('just one line, no sections')).toBe(null);
    });

    it('returns null for empty text (no sections)', () => {
      expect(getEntryLevelDate('')).toBe(null);
    });
  });
});
