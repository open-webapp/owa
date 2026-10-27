import { describe, it, expect } from 'vitest';
import { filterEntries, filterParagraphsInEntry, dateMatchesSelection, tagMatchesSelected, matchesDateTab, sectionDateForTab, filterParagraphsForTab, filterEntriesForTab } from '../entryFiltering.js';
import { Entry } from '../types.js';

describe('tagMatchesSelected', () => {
  it('matches an exact tag', () => {
    expect(tagMatchesSelected('#work', '#work')).toBe(true);
  });

  it('matches a child tag under the selected parent', () => {
    expect(tagMatchesSelected('#work/urgent', '#work')).toBe(true);
    expect(tagMatchesSelected('#work/later', '#work')).toBe(true);
  });

  it('does not match a tag that merely shares a prefix without a slash boundary', () => {
    expect(tagMatchesSelected('#worker', '#work')).toBe(false);
  });

  it('does not roll up from a child selection to a bare parent tag (parent-includes-child only)', () => {
    expect(tagMatchesSelected('#work', '#work/urgent')).toBe(false);
  });

  it('does not roll up from a child selection to a sibling child tag', () => {
    expect(tagMatchesSelected('#work/later', '#work/urgent')).toBe(false);
  });
});

describe('entryFiltering', () => {
  const mockEntries: Entry[] = [
    {
      id: '1',
      date: '2024-01-15',
      time: '10:00',
      text: 'Hello #work',
      archived: false,
      createdAt: 0,
    },
    {
      id: '2',
      date: '2024-01-15',
      time: '11:00',
      text: 'Personal note #personal',
      archived: false,
      createdAt: 0,
    },
    {
      id: '3',
      date: '2024-01-16',
      time: '09:00',
      text: 'Work meeting #work #meeting',
      archived: false,
      createdAt: 0,
    },
    {
      id: '4',
      date: '2024-01-16',
      time: '14:00',
      text: 'No tags here',
      archived: false,
      createdAt: 0,
    },
  ];

  describe('filterEntries', () => {
    it('returns all entries in all mode sorted date-desc/time-desc', () => {
      const result = filterEntries(mockEntries, 'all', [], '');
      expect(result).toHaveLength(4);
      // Check sorting: dates should be in descending order
      expect(result[0].date).toBe('2024-01-16');
      expect(result[1].date).toBe('2024-01-16');
      expect(result[2].date).toBe('2024-01-15');
      expect(result[3].date).toBe('2024-01-15');
      // Within same date, time should be descending
      expect(result[0].time).toBe('14:00');
      expect(result[1].time).toBe('09:00');
      expect(result[2].time).toBe('11:00');
      expect(result[3].time).toBe('10:00');
    });

    it('filters by tag in tag mode', () => {
      const result = filterEntries(mockEntries, 'tag', ['#work'], '');
      expect(result).toHaveLength(2);
      expect(result.some(e => e.id === '1')).toBe(true);
      expect(result.some(e => e.id === '3')).toBe(true);
    });

    it('handles multiple tags with OR logic', () => {
      const result = filterEntries(mockEntries, 'tag', ['#work', '#personal'], '');
      expect(result).toHaveLength(3);
    });

    it('handles untagged filter', () => {
      const result = filterEntries(mockEntries, 'tag', ['__untagged__'], '');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('4');
    });

    describe('hierarchical tag rollup', () => {
      const hierarchicalEntries: Entry[] = [
        {
          id: 'h1',
          date: '2024-01-15',
          time: '10:00',
          text: 'Section tagged with a child #work/urgent',
          archived: false,
          createdAt: 0,
        },
        {
          id: 'h2',
          date: '2024-01-15',
          time: '11:00',
          text: 'Section tagged with another child #work/later',
          archived: false,
          createdAt: 0,
        },
        {
          id: 'h3',
          date: '2024-01-15',
          time: '12:00',
          text: 'Section tagged bare #work',
          archived: false,
          createdAt: 0,
        },
        {
          id: 'h4',
          date: '2024-01-15',
          time: '13:00',
          text: 'Section tagged with a lookalike #worker',
          archived: false,
          createdAt: 0,
        },
      ];

      it('selecting #work matches child tags #work/urgent and #work/later, plus bare #work, but not #worker', () => {
        const result = filterEntries(hierarchicalEntries, 'tag', ['#work'], '');
        expect(result.map(e => e.id).sort()).toEqual(['h1', 'h2', 'h3']);
      });

      it('selecting a child tag #work/urgent does not roll up to sibling or parent sections', () => {
        const result = filterEntries(hierarchicalEntries, 'tag', ['#work/urgent'], '');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('h1');
      });

      it('__untagged__ selection is unaffected by hierarchical rollup (matches only zero-tag sections)', () => {
        const result = filterEntries(hierarchicalEntries, 'tag', ['__untagged__'], '');
        expect(result).toHaveLength(0);
      });

      it('no crossover: a tag with no children in a different family does not match unrelated child tags', () => {
        const result = filterEntries(hierarchicalEntries, 'tag', ['#personal'], '');
        expect(result).toHaveLength(0);
      });
    });

    it('filters by search query in search mode', () => {
      const result = filterEntries(mockEntries, 'search', [], 'meeting');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('3');
    });

    it('search is case-insensitive', () => {
      const result = filterEntries(mockEntries, 'search', [], 'HELLO');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('sorts by date descending', () => {
      const filtered = filterEntries(mockEntries, 'all', [], '');
      expect(filtered[0].date >= filtered[1].date).toBe(true);
    });

    it('sorts by time descending within same date', () => {
      const result = filterEntries(mockEntries, 'all', [], '');
      // Filter to same date for this test
      const sameDate = result.filter(e => e.date === '2024-01-15');
      expect(sameDate[0].time > sameDate[1].time).toBe(true);
    });
  });

  describe('filterParagraphsInEntry', () => {
    const entry: Entry = {
      id: '1',
      date: '2024-01-15',
      time: '10:00',
      text: 'First #work\n\nSecond #personal\n\nThird',
      archived: false,
      createdAt: 0,
    };

    it('returns all paragraphs in all mode', () => {
      const result = filterParagraphsInEntry(entry, 'all', [], '');
      expect(result).toHaveLength(3);
    });

    it('filters paragraphs by tag in tag mode', () => {
      const result = filterParagraphsInEntry(entry, 'tag', ['#work'], '');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('First #work');
    });

    it('handles untagged in tag mode', () => {
      const result = filterParagraphsInEntry(entry, 'tag', ['__untagged__'], '');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Third');
    });

    describe('hierarchical tag rollup', () => {
      it('selecting #work matches a section tagged only #work/urgent', () => {
        const entryWithChildTag: Entry = {
          id: 'hc1',
          date: '2024-01-15',
          time: '10:00',
          text: 'First #work/urgent\n\nSecond #personal',
          archived: false,
          createdAt: 0,
        };
        const result = filterParagraphsInEntry(entryWithChildTag, 'tag', ['#work'], '');
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('First #work/urgent');
      });

      it('selecting #work matches a section tagged only #work/later', () => {
        const entryWithChildTag: Entry = {
          id: 'hc2',
          date: '2024-01-15',
          time: '10:00',
          text: 'First #work/later\n\nSecond #personal',
          archived: false,
          createdAt: 0,
        };
        const result = filterParagraphsInEntry(entryWithChildTag, 'tag', ['#work'], '');
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('First #work/later');
      });

      it('selecting #work still matches a section tagged bare #work (unchanged flat behavior)', () => {
        const result = filterParagraphsInEntry(entry, 'tag', ['#work'], '');
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('First #work');
      });

      it('selecting #work does not match a section tagged #worker (prefix-with-slash check)', () => {
        const entryWithLookalike: Entry = {
          id: 'hc3',
          date: '2024-01-15',
          time: '10:00',
          text: 'First #worker\n\nSecond #personal',
          archived: false,
          createdAt: 0,
        };
        const result = filterParagraphsInEntry(entryWithLookalike, 'tag', ['#work'], '');
        expect(result).toHaveLength(0);
      });

      it('selecting a child tag #work/urgent does not roll up further to bare #work sections', () => {
        const entryWithBareParent: Entry = {
          id: 'hc4',
          date: '2024-01-15',
          time: '10:00',
          text: 'First #work\n\nSecond #work/urgent',
          archived: false,
          createdAt: 0,
        };
        const result = filterParagraphsInEntry(entryWithBareParent, 'tag', ['#work/urgent'], '');
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('Second #work/urgent');
      });

      it('__untagged__ selection is unaffected by the rollup change', () => {
        const result = filterParagraphsInEntry(entry, 'tag', ['__untagged__'], '');
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('Third');
      });

      it('entry-level trailing tag-only section with a hierarchical child tag still triggers the whole-entry branch', () => {
        const entryWithTrailingChildTag: Entry = {
          id: 'hc5',
          date: '2024-01-15',
          time: '10:00',
          text: 'note text\n\n#work/urgent',
          archived: false,
          createdAt: 0,
        };
        const result = filterParagraphsInEntry(entryWithTrailingChildTag, 'tag', ['#work'], '');
        expect(result).toHaveLength(2);
        expect(result[0]).toBe('note text');
        expect(result[1]).toBe('#work/urgent');
      });

      it('no crossover: selecting a childless tag from a different family does not match unrelated child tags', () => {
        const entryWithChildTag: Entry = {
          id: 'hc6',
          date: '2024-01-15',
          time: '10:00',
          text: 'First #work/urgent\n\nSecond #personal',
          archived: false,
          createdAt: 0,
        };
        const result = filterParagraphsInEntry(entryWithChildTag, 'tag', ['#other'], '');
        expect(result).toHaveLength(0);
      });
    });

    it('filters paragraphs by search query in search mode', () => {
      const result = filterParagraphsInEntry(entry, 'search', [], 'personal');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Second #personal');
    });

    // Test case 1: Entry with trailing tag-only section, filtering by entry-level tag -> returns all sections
    it('returns all sections when filtering by entry-level tag in trailing section', () => {
      const entryWithTrailingTag: Entry = {
        id: '1',
        date: '2024-01-15',
        time: '10:00',
        text: 'note text\n\n#work',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(entryWithTrailingTag, 'tag', ['#work'], '');
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('note text');
      expect(result[1]).toBe('#work');
    });

    // Test case 2: Entry where tag appears in earlier section -> filtering by that tag returns only that section
    it('returns only section-level match when tag appears in non-last section', () => {
      const entryWithTagInMiddle: Entry = {
        id: '2',
        date: '2024-01-15',
        time: '10:00',
        text: '#work stuff here\n\nmore text\n\n#personal',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(entryWithTagInMiddle, 'tag', ['#work'], '');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('#work stuff here');
    });

    // Test case 3: Entry with NON-trailing tag-only section -> old per-section behavior preserved
    it('applies section-level filtering when tag-only section is not last', () => {
      const entryWithEarlyTagSection: Entry = {
        id: '3',
        date: '2024-01-15',
        time: '10:00',
        text: '#work\n\nprose section',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(entryWithEarlyTagSection, 'tag', ['#work'], '');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('#work');
    });

    // Test case 4: Entry with two trailing tag-only sections
    it('handles multiple trailing tag-only sections correctly', () => {
      const entryWithTwoTrailingTags: Entry = {
        id: '4',
        date: '2024-01-15',
        time: '10:00',
        text: 'body\n\n#early\n\n#late',
        archived: false,
        createdAt: 0,
      };
      // Filtering by #late (the true last section's tag) returns all sections
      const resultLate = filterParagraphsInEntry(entryWithTwoTrailingTags, 'tag', ['#late'], '');
      expect(resultLate).toHaveLength(3);
      expect(resultLate[0]).toBe('body');
      expect(resultLate[1]).toBe('#early');
      expect(resultLate[2]).toBe('#late');

      // Filtering by #early (earlier tag-only section, not last) pairs it
      // with the content section right before it, showing both.
      const resultEarly = filterParagraphsInEntry(entryWithTwoTrailingTags, 'tag', ['#early'], '');
      expect(resultEarly).toHaveLength(2);
      expect(resultEarly[0]).toBe('body');
      expect(resultEarly[1]).toBe('#early');
    });

    // Regression: reported bug - an entry with two independently-tagged
    // sections (section, tag-only line, section, tag-only line) collapsed
    // to just the bare tag line instead of showing its paired section.
    it('pairs each section with its own following tag-only line (independent per-section tags)', () => {
      const entryWithTwoTaggedSections: Entry = {
        id: '9',
        date: '2024-01-15',
        time: '10:00',
        text: 'Section A text\n\n#tagA\n\nSection B text\n\n#tagB',
        archived: false,
        createdAt: 0,
      };
      // #tagA is not the entry's true trailing section, so it pairs with
      // just the content immediately before it (Section A).
      const resultA = filterParagraphsInEntry(entryWithTwoTaggedSections, 'tag', ['#tagA'], '');
      expect(resultA).toHaveLength(2);
      expect(resultA[0]).toBe('Section A text');
      expect(resultA[1]).toBe('#tagA');

      // #tagB IS the true trailing section, so per the existing
      // global-tag rule it applies to the whole entry.
      const resultB = filterParagraphsInEntry(entryWithTwoTaggedSections, 'tag', ['#tagB'], '');
      expect(resultB).toHaveLength(4);
      expect(resultB[3]).toBe('#tagB');
    });

    // Test case 5: filterEntries regression - entry with entry-level tag still appears in tag-mode entry list
    it('filterEntries includes entry with only entry-level tag when filtering by that tag', () => {
      const entryWithEntryLevelTag: Entry = {
        id: '5',
        date: '2024-01-15',
        time: '10:00',
        text: 'body text\n\n#project',
        archived: false,
        createdAt: 0,
      };
      const result = filterEntries([entryWithEntryLevelTag], 'tag', ['#project'], '');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('5');
    });

    // Test case 6: __untagged__ regression - entry-level tags must not swallow the untagged branch
    it('__untagged__ filter still works with entry-level tags present', () => {
      const entryWithEntryLevelTag: Entry = {
        id: '6',
        date: '2024-01-15',
        time: '10:00',
        text: 'body text\n\n#project',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(entryWithEntryLevelTag, 'tag', ['__untagged__'], '');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('body text');
    });

    // Test case 7: Multi-select union - OR semantics preserved through entry-level check
    it('handles multi-select union with entry-level tags', () => {
      const entryWithEntryLevelTag: Entry = {
        id: '7',
        date: '2024-01-15',
        time: '10:00',
        text: 'body\n\n#project',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(entryWithEntryLevelTag, 'tag', ['#other', '#project'], '');
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('body');
      expect(result[1]).toBe('#project');
    });

    // Test case 8: Retroactive-behavior test - old entries behave as entry-level after the change
    it('retroactively applies entry-level behavior to pre-existing entries', () => {
      const oldStyleEntry: Entry = {
        id: '8',
        date: '2024-01-15',
        time: '10:00',
        text: 'meeting notes here\n\n#meeting',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(oldStyleEntry, 'tag', ['#meeting'], '');
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('meeting notes here');
      expect(result[1]).toBe('#meeting');
    });
  });

  describe('filterEntries with selectedDate (tag mode + date)', () => {
    it('T6: Bug-fix test - date-only filter with empty selectedTags returns entry', () => {
      // This test will FAIL without the selectedTags.length === 0 guard
      const entryWithDate: Entry = {
        id: '1',
        date: '2026-01-05',
        time: '10:00',
        text: 'Some note @2026-01-05',
        archived: false,
        createdAt: 0,
      };
      // selectedTags is empty [], selectedDate is "2026-01-05"
      // Without the guard, selectedTags.some() returns false even though we want date-only filtering
      const result = filterEntries([entryWithDate], 'tag', [], '', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('filters by date when no date-containing sections match', () => {
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-01-05',
          time: '10:00',
          text: 'Section A @2026-01-05\n\nSection B no date',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-01-06',
          time: '10:00',
          text: 'Other note @2026-01-06',
          archived: false,
          createdAt: 0,
        },
      ];
      // Filter by date "2026-01-05" with no tag filter
      const result = filterEntries(entries, 'tag', [], '', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('AND logic: tag AND date both required (date may be satisfied by implicit entry date)', () => {
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-01-05',
          time: '10:00',
          text: '#work @2026-01-05',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-01-05',
          time: '10:00',
          text: '#work no date',
          archived: false,
          createdAt: 0,
        },
        {
          id: '3',
          date: '2026-01-05',
          time: '10:00',
          text: 'no tag @2026-01-05',
          archived: false,
          createdAt: 0,
        },
      ];
      // Filter by tag "#work" AND date "2026-01-05"
      // Entry 1 matches via its explicit token; entry 2 also matches because
      // its section's implicit date (the entry's own date) equals the
      // selected date. Entry 3 is excluded (no tag match).
      const result = filterEntries(entries, 'tag', ['#work'], '', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result.some(e => e.id === '1')).toBe(true);
      expect(result.some(e => e.id === '2')).toBe(true);
    });

    it('AND logic: tag AND date both required, with a differing implicit date to actually exclude a section', () => {
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-01-05',
          time: '10:00',
          text: '#work @2026-01-05',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-02-09',
          time: '10:00',
          text: '#work no date',
          archived: false,
          createdAt: 0,
        },
        {
          id: '3',
          date: '2026-01-05',
          time: '10:00',
          text: 'no tag @2026-01-05',
          archived: false,
          createdAt: 0,
        },
      ];
      // Entry 2's implicit date (2026-02-09) does not match the selected
      // date, so it is excluded even though it has the tag.
      const result = filterEntries(entries, 'tag', ['#work'], '', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('no selectedDate = regression - tag-only filtering unchanged', () => {
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-01-05',
          time: '10:00',
          text: '#work @2026-01-05',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-01-05',
          time: '10:00',
          text: '#work no date',
          archived: false,
          createdAt: 0,
        },
      ];
      // Filter by tag only (no selectedDate or selectedDate=null)
      // Both should match (old behavior)
      const result = filterEntries(entries, 'tag', ['#work'], '');
      expect(result).toHaveLength(2);
    });

    it('search mode ignores selectedDate - precedence unchanged', () => {
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-01-05',
          time: '10:00',
          text: 'hello @2026-01-05',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-01-06',
          time: '10:00',
          text: 'hello @2026-01-06',
          archived: false,
          createdAt: 0,
        },
      ];
      // Even with selectedDate, search mode should return both (date filter ignored in search mode)
      const result = filterEntries(entries, 'search', [], 'hello', '2026-01-05');
      expect(result).toHaveLength(2);
    });
  });

  describe('filterParagraphsInEntry with selectedDate (tag mode + date)', () => {
    it('filters sections by date when selectedDate provided (implicit entry date also matches)', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-01-05',
        time: '10:00',
        text: 'Section A @2026-01-05\n\nSection B @2026-01-06',
        archived: false,
        createdAt: 0,
      };
      // Filter by date "2026-01-05" with no tag filter. Section A matches
      // via its explicit token (same as the entry's implicit date, deduped).
      // Section B also matches because the entry's own implicit date
      // (2026-01-05) is part of its resolved date set, even though its
      // explicit token (2026-01-06) differs.
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Section A @2026-01-05');
      expect(result[1]).toBe('Section B @2026-01-06');
    });

    it('date filter excludes a section whose implicit AND explicit dates both differ', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-01-05',
        time: '10:00',
        text: 'Section A @2026-01-05\n\nSection B @2026-02-09',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-02-10');
      expect(result).toHaveLength(0);
    });

    it('AND logic in filterParagraphsInEntry: tag AND date both required (implicit date can satisfy the date half)', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-01-05',
        time: '10:00',
        text: '#work @2026-01-05\n\n#work no date\n\nno tag @2026-01-05',
        archived: false,
        createdAt: 0,
      };
      // Filter by tag "#work" AND date "2026-01-05". Both #work sections
      // match: the first via its explicit token, the second via the
      // entry's own implicit date. The third section is excluded (no tag).
      const result = filterParagraphsInEntry(entry, 'tag', ['#work'], '', '2026-01-05');
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('#work @2026-01-05');
      expect(result[1]).toBe('#work no date');
    });

    it('date-only filter in filterParagraphsInEntry (all sections share the implicit entry date)', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-01-05',
        time: '10:00',
        text: 'Undated section\n\n@2026-01-05 only date\n\n#tag no date',
        archived: false,
        createdAt: 0,
      };
      // Every section's resolved dates include the entry's own implicit
      // date (2026-01-05), so all three sections match.
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-01-05');
      expect(result).toHaveLength(3);
    });

    it('no selectedDate = regression - tag-only filtering in filterParagraphsInEntry', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-01-05',
        time: '10:00',
        text: '#work @2026-01-05\n\n#work no date\n\nno tag @2026-01-05',
        archived: false,
        createdAt: 0,
      };
      // Filter by tag only (no selectedDate)
      // Both #work sections should match
      const result = filterParagraphsInEntry(entry, 'tag', ['#work'], '');
      expect(result).toHaveLength(2);
    });

    it('search mode ignores selectedDate in filterParagraphsInEntry', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-01-05',
        time: '10:00',
        text: 'hello @2026-01-05\n\nhello @2026-01-06',
        archived: false,
        createdAt: 0,
      };
      // Even with selectedDate, search mode should return both
      const result = filterParagraphsInEntry(entry, 'search', [], 'hello', '2026-01-05');
      expect(result).toHaveLength(2);
    });
  });

  describe('T7: Mixed-format date tokens (regression coverage)', () => {
    it('filters sections correctly across different date formats (all normalize to same ISO date)', () => {
      // Three sections using different formats for the same date: 2026-08-17
      const entry: Entry = {
        id: '1',
        date: '2026-08-15',
        time: '10:00',
        text: 'Section A @2026-08-17\n\nSection B @08-17-2026\n\nSection C @2026/08/17',
        archived: false,
        createdAt: 0,
      };
      // Filter by selectedDate='2026-08-17' with no tag filter
      // All three sections should match (all formats normalize to same ISO date)
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-08-17');
      expect(result).toHaveLength(3);
      expect(result[0]).toBe('Section A @2026-08-17');
      expect(result[1]).toBe('Section B @08-17-2026');
      expect(result[2]).toBe('Section C @2026/08/17');
    });

    it('mixed-format dates collapse into single bucket when filtering entries', () => {
      // Three entries, each with a single section using different formats for 2026-08-17
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-08-15',
          time: '10:00',
          text: 'Entry 1 @2026-08-17',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-08-15',
          time: '11:00',
          text: 'Entry 2 @08-17-2026',
          archived: false,
          createdAt: 0,
        },
        {
          id: '3',
          date: '2026-08-15',
          time: '12:00',
          text: 'Entry 3 @2026/08/17',
          archived: false,
          createdAt: 0,
        },
      ];
      // Filter by selectedDate='2026-08-17'
      // All three entries should be returned
      const result = filterEntries(entries, 'tag', [], '', '2026-08-17');
      expect(result).toHaveLength(3);
    });

    it('invalid dates (e.g., @2026-02-30) are excluded from date filtering', () => {
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-08-15',
          time: '10:00',
          text: 'Valid date @2026-08-17',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-08-15',
          time: '11:00',
          text: 'Invalid date @2026-02-30',
          archived: false,
          createdAt: 0,
        },
      ];
      // Filter by selectedDate='2026-08-17'
      // Only entry 1 should be returned (entry 2's invalid date token is not parsed)
      const result = filterEntries(entries, 'tag', [], '', '2026-08-17');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('tag+date AND semantics with mixed formats', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-08-15',
        time: '10:00',
        text: '#work @2026-08-17\n\n#work @2026/08/18\n\nno-tag @08-17-2026',
        archived: false,
        createdAt: 0,
      };
      // Filter by tag "#work" AND date "2026-08-17"
      // Should return only the first section (has both tag and matching date in same section)
      const result = filterParagraphsInEntry(entry, 'tag', ['#work'], '', '2026-08-17');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('#work @2026-08-17');
    });

    it('invalid date token does not interfere with section filtering', () => {
      const entry: Entry = {
        id: '1',
        date: '2026-08-15',
        time: '10:00',
        text: '#work @2026-02-30\n\n#work @2026-08-17',
        archived: false,
        createdAt: 0,
      };
      // Filter by tag "#work" AND date "2026-08-17"
      // Invalid date in first section does not prevent filtering by date
      // Only second section should be returned (has matching tag AND valid date)
      const result = filterParagraphsInEntry(entry, 'tag', ['#work'], '', '2026-08-17');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('#work @2026-08-17');
    });

    it('entries containing only invalid dates are excluded from date filtering', () => {
      const entries: Entry[] = [
        {
          id: '1',
          date: '2026-08-15',
          time: '10:00',
          text: 'Valid section @2026-08-17',
          archived: false,
          createdAt: 0,
        },
        {
          id: '2',
          date: '2026-08-15',
          time: '11:00',
          text: 'Only invalid dates @2026-02-30 @2026-04-31',
          archived: false,
          createdAt: 0,
        },
      ];
      const result = filterEntries(entries, 'tag', [], '', '2026-08-17');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  describe('dateMatchesSelection', () => {
    it('exact day match', () => {
      expect(dateMatchesSelection(['2026-08-15'], '2026-08-15')).toBe(true);
    });

    it('day selection does not match a different day', () => {
      expect(dateMatchesSelection(['2026-08-15'], '2026-08-16')).toBe(false);
    });

    it('month-prefix selection matches a day within that month', () => {
      expect(dateMatchesSelection(['2026-08-15'], '2026-08')).toBe(true);
    });

    it('month-prefix selection does not match a day in a different month', () => {
      expect(dateMatchesSelection(['2026-07-31'], '2026-08')).toBe(false);
    });

    it('returns false for a selection of unexpected length', () => {
      expect(dateMatchesSelection(['2026-08-15'], '2026')).toBe(false);
      expect(dateMatchesSelection(['2026-08-15'], '')).toBe(false);
    });
  });

  describe('implicit entry date + month bucketing (browse-by-date-implicit-entry-date)', () => {
    const entry: Entry = {
      id: '1',
      date: '2026-08-15',
      time: '10:00',
      text: 'Team sync @2026-01-05\n\nRandom note',
      archived: false,
      createdAt: 0,
    };

    it('implicit-only match: selecting the entry date returns both sections', () => {
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-08-15');
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Team sync @2026-01-05');
      expect(result[1]).toBe('Random note');
    });

    it('dual-bucket match: selecting the explicit token date returns only the first section', () => {
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Team sync @2026-01-05');
    });

    it('month-prefix match on the explicit token date returns only the first section', () => {
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-01');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Team sync @2026-01-05');
    });

    it('month-prefix match on the implicit entry date returns both sections', () => {
      const result = filterParagraphsInEntry(entry, 'tag', [], '', '2026-08');
      expect(result).toHaveLength(2);
    });

    it('filterEntries mirrors implicit/dual-bucket/month-prefix matching at the entry level', () => {
      expect(filterEntries([entry], 'tag', [], '', '2026-08-15')).toHaveLength(1);
      expect(filterEntries([entry], 'tag', [], '', '2026-01-05')).toHaveLength(1);
      expect(filterEntries([entry], 'tag', [], '', '2026-01')).toHaveLength(1);
      expect(filterEntries([entry], 'tag', [], '', '2026-08')).toHaveLength(1);
      // A date that matches neither the implicit nor the explicit date
      // excludes the entry entirely.
      expect(filterEntries([entry], 'tag', [], '', '2026-02')).toHaveLength(0);
    });

    it('AND-with-tags regression: tag AND explicit date both required', () => {
      const taggedEntry: Entry = {
        id: '2',
        date: '2026-08-15',
        time: '10:00',
        text: 'Team sync #work @2026-01-05\n\nOther #work',
        archived: false,
        createdAt: 0,
      };
      const result = filterParagraphsInEntry(taggedEntry, 'tag', ['#work'], '', '2026-01-05');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Team sync #work @2026-01-05');
    });

    it('no-date-selected regression: selectedDate = null trivially passes the date check', () => {
      const result = filterParagraphsInEntry(entry, 'tag', [], '', null);
      expect(result).toHaveLength(2);
    });

    it('existing 4-arg calls (omitting selectedDate) still compile and behave unchanged', () => {
      const result = filterParagraphsInEntry(entry, 'all', [], '');
      expect(result).toHaveLength(2);
      const entriesResult = filterEntries([entry], 'all', [], '');
      expect(entriesResult).toHaveLength(1);
    });
  });
});

describe('matchesDateTab', () => {
  it('ToDo tab matches any valid explicit date: future, today and past due', () => {
    expect(matchesDateTab('2026-09-01', 'upcoming', '2026-08-31')).toBe(true);
    expect(matchesDateTab('2026-08-31', 'upcoming', '2026-08-31')).toBe(true);
    expect(matchesDateTab('2026-08-30', 'upcoming', '2026-08-31')).toBe(true);
  });

  it('malformed/absent date never matches upcoming', () => {
    expect(matchesDateTab(null, 'upcoming', '2026-08-31')).toBe(false);
  });

  it('all tab always matches, including null explicitDate', () => {
    expect(matchesDateTab(null, 'all', '2026-08-31')).toBe(true);
    expect(matchesDateTab('2020-01-01', 'all', '2026-08-31')).toBe(true);
    expect(matchesDateTab('2099-01-01', 'all', '2026-08-31')).toBe(true);
  });
});

describe('sectionDateForTab', () => {
  const entry: Entry = {
    id: '1',
    date: '2024-01-15',
    time: '10:00',
    text: 'Some text @2024-02-01',
    archived: false,
    createdAt: 0,
  };

  it('entry-level date wins even if the section has its own differing explicit date', () => {
    const section = 'Some text @2024-02-01';
    expect(sectionDateForTab(section, entry, '2026-01-01')).toBe('2026-01-01');
  });

  it('falls back to the section explicit date when entryLevelDate is null', () => {
    const section = 'Some text @2024-02-01';
    expect(sectionDateForTab(section, entry, null)).toBe('2024-02-01');
  });

  it('falls back to null when entryLevelDate is null and section has no explicit date', () => {
    const section = 'Some text with no date token';
    expect(sectionDateForTab(section, entry, null)).toBe(null);
  });
});

describe('filterParagraphsForTab', () => {
  const todayIso = '2026-08-31';

  function makeEntry(text: string, date = '2026-08-01'): Entry {
    return {
      id: '1',
      date,
      time: '10:00',
      text,
      archived: false,
      createdAt: 0,
    };
  }

  it('basic upcoming match: returns only the section with a future explicit date', () => {
    const entry = makeEntry('Team sync #work @2026-09-15\n\nRandom note');
    expect(filterParagraphsForTab(entry, 'upcoming', [], null, '', todayIso)).toEqual([
      'Team sync #work @2026-09-15',
    ]);
  });

  it('past-due dated section is kept in ToDo tab; undated sections excluded', () => {
    const entry = makeEntry('Team sync #work @2026-01-05\n\nRandom note');
    expect(filterParagraphsForTab(entry, 'upcoming', [], null, '', todayIso)).toEqual(['Team sync #work @2026-01-05']);
  });

  it('no explicit date anywhere: ToDo tab excludes entirely', () => {
    const entry = makeEntry('Team sync #work\n\nRandom note');
    expect(filterParagraphsForTab(entry, 'upcoming', [], null, '', todayIso)).toEqual([]);
  });

  it('malformed @date token does not match ToDo tab', () => {
    const entry = makeEntry('Bad @2026-13-40');
    expect(filterParagraphsForTab(entry, 'upcoming', [], null, '', todayIso)).toEqual([]);
  });

  it('entry-level date exception: trailing date-only section applies to all sections', () => {
    const entry = makeEntry('Plan trip\n\nBook flights\n\n@2026-12-25');
    expect(filterParagraphsForTab(entry, 'upcoming', [], null, '', '2026-08-31')).toEqual([
      'Plan trip',
      'Book flights',
      '@2026-12-25',
    ]);
  });

  it('entry-level tag+date exception together: both entry-level, tag mismatch excludes even though date passes', () => {
    const entry = makeEntry('Plan trip\n\nBook flights\n\n#travel @2026-12-25');
    expect(filterParagraphsForTab(entry, 'upcoming', ['#travel'], null, '', '2026-08-31')).toEqual([
      'Plan trip',
      'Book flights',
      '#travel @2026-12-25',
    ]);
    expect(filterParagraphsForTab(entry, 'upcoming', ['#other'], null, '', '2026-08-31')).toEqual([]);
  });

  it('AND with selectedTags (non-entry-level): only the matching-tag section is returned', () => {
    const entry = makeEntry('Note A #work @2026-12-25\n\nNote B #home @2026-12-25');
    expect(filterParagraphsForTab(entry, 'upcoming', ['#work'], null, '', todayIso)).toEqual([
      'Note A #work @2026-12-25',
    ]);
  });

  it('AND with selectedDate (Browse-by-Date): only the section matching the month prefix is returned', () => {
    const entry = makeEntry('First note @2026-12-10\n\nSecond note @2026-11-05');
    expect(filterParagraphsForTab(entry, 'upcoming', [], '2026-12', '', todayIso)).toEqual([
      'First note @2026-12-10',
    ]);
  });

  it('AND with search: narrows the tab result instead of overriding it', () => {
    const entry = makeEntry('Alpha note @2026-12-25\n\nBeta note @2026-12-26');
    expect(filterParagraphsForTab(entry, 'upcoming', [], null, 'alpha', todayIso)).toEqual([
      'Alpha note @2026-12-25',
    ]);
  });

  it('non-trailing tag-only line pairing still works via groupSectionsByTag', () => {
    const entry = makeEntry('Meeting notes\n\n#work @2026-12-25\n\nOther note');
    expect(filterParagraphsForTab(entry, 'upcoming', ['#work'], null, '', todayIso)).toEqual([
      'Meeting notes',
      '#work @2026-12-25',
    ]);
  });
});

describe('filterEntriesForTab', () => {
  const todayIso = '2026-08-31';

  function makeEntry(id: string, text: string, date = '2026-08-01', time = '10:00'): Entry {
    return {
      id,
      date,
      time,
      text,
      archived: false,
      createdAt: 0,
    };
  }

  it('3 entries with distinct future explicit dates: upcoming returns them sorted ascending (soonest first)', () => {
    const e1 = makeEntry('1', 'Later @2026-12-01');
    const e2 = makeEntry('2', 'Soonest @2026-09-05');
    const e3 = makeEntry('3', 'Middle @2026-10-15');
    const result = filterEntriesForTab([e1, e2, e3], 'upcoming', [], null, '', todayIso);
    expect(result.map(e => e.id)).toEqual(['2', '3', '1']);
  });

  it('past-due entries are included, ordered by earliest dated section ascending with upcoming', () => {
    const e1 = makeEntry('1', 'Past @2026-05-15');
    const e2 = makeEntry('2', 'Future @2026-09-05');
    expect(filterEntriesForTab([e2, e1], 'upcoming', [], null, '', todayIso).map(e => e.id)).toEqual(['1', '2']);
  });

  it('entry with no explicit date anywhere is excluded', () => {
    const withDate = makeEntry('1', 'Has a date @2026-09-05');
    const noDate = makeEntry('2', 'No date at all here');
    expect(filterEntriesForTab([withDate, noDate], 'upcoming', [], null, '', todayIso).map(e => e.id)).toEqual(['1']);
  });

  it('malformed @date token does not qualify', () => {
    expect(filterEntriesForTab([makeEntry('1', 'Bad @2026-13-40')], 'upcoming', [], null, '', todayIso)).toEqual([]);
  });

  it('excludes an entry whose otherwise-qualifying date fails a selectedTags/selectedDate/searchQuery mismatch', () => {
    const entry = makeEntry('1', 'Trip planning #work @2026-09-05');
    expect(filterEntriesForTab([entry], 'upcoming', ['#other'], null, '', todayIso)).toEqual([]);
    expect(filterEntriesForTab([entry], 'upcoming', [], '2026-12', '', todayIso)).toEqual([]);
    expect(filterEntriesForTab([entry], 'upcoming', [], null, 'nomatch', todayIso)).toEqual([]);
  });

  it('two entries sharing the exact same sort-key date are tie-broken by entry date/time desc', () => {
    const e1 = makeEntry('1', 'First @2026-09-05', '2026-08-01', '09:00');
    const e2 = makeEntry('2', 'Second @2026-09-05', '2026-08-02', '09:00');
    const result = filterEntriesForTab([e1, e2], 'upcoming', [], null, '', todayIso);
    // Same sort-key date (2026-09-05); tie-break by entry.date desc -> e2 (08-02) before e1 (08-01)
    expect(result.map(e => e.id)).toEqual(['2', '1']);
  });

  it('excludes archived entries', () => {
    const archived = { ...makeEntry('1', 'Gone @2026-09-05'), archived: true };
    const done = { ...makeEntry('2', 'Gone done'), archived: true, doneAt: 5 };
    expect(filterEntriesForTab([archived, done], 'upcoming', [], null, '', todayIso)).toEqual([]);
  });

  describe('done entries in ToDo tab', () => {
    function doneEntry(id: string, text: string, doneAt?: number, date = '2026-08-01', time = '10:00'): Entry {
      return { id, date, time, text, archived: false, createdAt: 0, doneAt };
    }

    it('keeps done entries (dated or not) alongside open ones; visibility is a board concern', () => {
      const entries = [
        doneEntry('done-undated', 'Completed #work', 100),
        doneEntry('done-dated', 'Finished @2026-08-01', 100),
        doneEntry('upcoming', 'Scheduled @2026-09-05'),
        doneEntry('undated', 'Plain'),
      ];
      expect(filterEntriesForTab(entries, 'upcoming', [], null, '', todayIso).map(e => e.id).sort())
        .toEqual(['done-dated', 'done-undated', 'upcoming']);
    });

    it('returns all sections of a done entry, including undated ones', () => {
      const e = doneEntry('d', 'First\n\nSecond @2026-09-05', 100);
      expect(filterParagraphsForTab(e, 'upcoming', [], null, '', todayIso)).toEqual(['First', 'Second @2026-09-05']);
    });

    it('ANDs tags and browse-by-date, and search narrows done entries', () => {
      const entries = [
        doneEntry('match', 'Find report #work @2026-09-05', 100),
        doneEntry('wrong-tag', 'Find report #home @2026-09-05', 200),
        doneEntry('wrong-date', 'Find report #work @2026-10-05', 300),
        doneEntry('wrong-search', 'Archive report #work @2026-09-05', 400),
      ];
      expect(filterEntriesForTab(entries, 'upcoming', ['#work'], '2026-09', 'find', todayIso).map(e => e.id)).toEqual(['match']);
    });

    it('treats non-positive / non-finite doneAt as not done (undated then excluded)', () => {
      const entries = [
        doneEntry('positive', 'Positive', 1),
        doneEntry('zero', 'Zero', 0),
        doneEntry('negative', 'Negative', -1),
        doneEntry('nan', 'NaN', Number.NaN),
        doneEntry('inf', 'Inf', Infinity),
        doneEntry('nan-dated', 'Dated @2026-09-05', Number.NaN),
      ];
      expect(filterEntriesForTab(entries, 'upcoming', [], null, '', todayIso).map(e => e.id).sort()).toEqual(['nan-dated', 'positive']);
    });
  });
});

describe('activeTab all / legacy behavior regression', () => {
  // Belt-and-suspenders confirmation that filterEntries/filterParagraphsInEntry
  // (unmodified by the DateTab feature) still produce byte-identical output
  // for representative fixtures already covered by existing tests above,
  // spanning 'all', 'tag', and 'search' modes.

  const mockEntries: Entry[] = [
    {
      id: '1',
      date: '2024-01-15',
      time: '10:00',
      text: 'Hello #work',
      archived: false,
      createdAt: 0,
    },
    {
      id: '2',
      date: '2024-01-15',
      time: '11:00',
      text: 'Personal note #personal',
      archived: false,
      createdAt: 0,
    },
    {
      id: '3',
      date: '2024-01-16',
      time: '09:00',
      text: 'Work meeting #work #meeting',
      archived: false,
      createdAt: 0,
    },
    {
      id: '4',
      date: '2024-01-16',
      time: '14:00',
      text: 'No tags here',
      archived: false,
      createdAt: 0,
    },
  ];

  it('[all mode] filterEntries returns all entries sorted date-desc/time-desc, unchanged', () => {
    const result = filterEntries(mockEntries, 'all', [], '');
    expect(result).toHaveLength(4);
    expect(result[0].date).toBe('2024-01-16');
    expect(result[1].date).toBe('2024-01-16');
    expect(result[2].date).toBe('2024-01-15');
    expect(result[3].date).toBe('2024-01-15');
    expect(result[0].time).toBe('14:00');
    expect(result[1].time).toBe('09:00');
    expect(result[2].time).toBe('11:00');
    expect(result[3].time).toBe('10:00');
  });

  it('[tag mode] filterEntries filters by tag, unchanged', () => {
    const result = filterEntries(mockEntries, 'tag', ['#work'], '');
    expect(result).toHaveLength(2);
    expect(result.some(e => e.id === '1')).toBe(true);
    expect(result.some(e => e.id === '3')).toBe(true);
  });

  it('[search mode] filterEntries filters by search query, unchanged', () => {
    const result = filterEntries(mockEntries, 'search', [], 'meeting');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  const entry: Entry = {
    id: '1',
    date: '2024-01-15',
    time: '10:00',
    text: 'First #work\n\nSecond #personal\n\nThird',
    archived: false,
    createdAt: 0,
  };

  it('[all mode] filterParagraphsInEntry returns all paragraphs, unchanged', () => {
    const result = filterParagraphsInEntry(entry, 'all', [], '');
    expect(result).toHaveLength(3);
  });

  it('[tag mode] filterParagraphsInEntry filters paragraphs by tag, unchanged', () => {
    const result = filterParagraphsInEntry(entry, 'tag', ['#work'], '');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('First #work');
  });

  it('[search mode] filterParagraphsInEntry filters paragraphs by search query, unchanged', () => {
    const result = filterParagraphsInEntry(entry, 'search', [], 'personal');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Second #personal');
  });
});
