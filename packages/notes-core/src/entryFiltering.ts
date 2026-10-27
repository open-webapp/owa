/**
 * Entry filtering logic for the Notes Diary app.
 */

import { Entry } from './types.js';
import { ViewMode } from './mode.js';
import { splitParts, splitSections, getEntryLevelTags, isTagOnlySection, extractTags, resolveSectionDates, getExplicitSectionDate, getEntryLevelDate } from './tags.js';

interface TagGroup {
  sections: string[];
  tags: string[];
}

/**
 * Groups a run of sections (the entry's sections minus any true trailing
 * global tag-only section) by non-final tag-only lines: a tag-only section
 * pairs with the content section(s) immediately preceding it into one group,
 * so filtering by that line's tag shows both together instead of the bare
 * tag line alone. Any trailing content with no closing tag-only line is
 * returned separately as `leftover`, matched section-by-section as before.
 */
function groupSectionsByTag(sections: string[]): { groups: TagGroup[]; leftover: string[] } {
  const groups: TagGroup[] = [];
  let pending: string[] = [];
  for (const section of sections) {
    if (isTagOnlySection(section)) {
      groups.push({ sections: [...pending, section], tags: extractTags(section) });
      pending = [];
    } else {
      pending.push(section);
    }
  }
  return { groups, leftover: pending };
}

export function tagMatchesSelected(tag: string, selected: string): boolean {
  return tag === selected || tag.startsWith(selected + '/');
}

function tagsMatchSelection(tags: string[], selectedTags: string[]): boolean {
  if (selectedTags.length === 0) {
    return true;
  }
  return selectedTags.some(st =>
    st === '__untagged__' ? tags.length === 0 : tags.some(t => tagMatchesSelected(t, st))
  );
}

/**
 * Determine whether a section's resolved dates (implicit entry date, plus
 * optional differing explicit @date token) match a selectedDate filter.
 * selectedDate may be a day (YYYY-MM-DD) or a month prefix (YYYY-MM).
 */
export function dateMatchesSelection(resolvedDates: string[], selectedDate: string): boolean {
  if (selectedDate.length === 10) {
    return resolvedDates.some(d => d === selectedDate);
  }
  if (selectedDate.length === 7) {
    return resolvedDates.some(d => d.startsWith(selectedDate));
  }
  return false;
}

export function filterEntries(
  entries: Entry[],
  mode: ViewMode,
  selectedTags: string[],
  searchQuery: string,
  selectedDate: string | null = null
): Entry[] {
  let filtered = entries;

  if (mode === 'all') {
    filtered = entries;
  } else if (mode === 'tag') {
    filtered = entries.filter(e => {
      const sections = splitSections(e.text);
      return sections.some(section => {
        const parts = splitParts(section);
        const tags = parts.filter(pt => pt.isTag).map(pt => pt.text);
        const tagOk = selectedTags.length === 0 ? true : selectedTags.some(st => {
          if (st === '__untagged__') {
            return tags.length === 0;
          }
          return tags.some(t => tagMatchesSelected(t, st));
        });
        if (!tagOk) {
          return false;
        }
        if (selectedDate === null) {
          return true;
        }
        const resolvedDates = resolveSectionDates(section, e.date);
        return dateMatchesSelection(resolvedDates, selectedDate);
      });
    });
  } else if (mode === 'search') {
    const query = searchQuery.toLowerCase();
    filtered = entries.filter(e => {
      const text = e.text.toLowerCase();
      return text.includes(query);
    });
  }

  // Sort: date desc, then time desc
  filtered.sort((a, b) => {
    if (a.date !== b.date) {
      return b.date.localeCompare(a.date);
    }
    return b.time.localeCompare(a.time);
  });

  return filtered;
}

export function filterParagraphsInEntry(
  entry: Entry,
  mode: ViewMode,
  selectedTags: string[],
  searchQuery: string,
  selectedDate: string | null = null
): string[] {
  const sections = splitSections(entry.text);

  if (mode === 'all') {
    return sections;
  }

  if (mode === 'tag') {
    const lastIdx = sections.length - 1;
    const hasGlobalTag = lastIdx >= 0 && isTagOnlySection(sections[lastIdx]);

    if (hasGlobalTag) {
      const entryLevelTags = getEntryLevelTags(entry.text);
      const tagOk = selectedTags.length === 0 ? true : selectedTags.some(st => entryLevelTags.some(t => tagMatchesSelected(t, st)));
      if (tagOk) {
        // If date filter is active, still need to filter by date
        if (selectedDate !== null) {
          return sections.filter(section => {
            const resolvedDates = resolveSectionDates(section, entry.date);
            return dateMatchesSelection(resolvedDates, selectedDate);
          });
        }
        return sections;
      }
    }

    // Not (or not entirely) covered by the true trailing global tag: pair
    // any other tag-only line with the content immediately before it, so a
    // filter on that line's tag reveals the paired content instead of just
    // the bare tag line.
    const remaining = hasGlobalTag ? sections.slice(0, lastIdx) : sections;
    const { groups, leftover } = groupSectionsByTag(remaining);
    const result: string[] = [];

    for (const group of groups) {
      if (!tagsMatchSelection(group.tags, selectedTags)) {
        continue;
      }
      if (selectedDate !== null) {
        const dateOk = group.sections.some(section =>
          dateMatchesSelection(resolveSectionDates(section, entry.date), selectedDate)
        );
        if (!dateOk) {
          continue;
        }
      }
      result.push(...group.sections);
    }

    for (const section of leftover) {
      const parts = splitParts(section);
      const tags = parts.filter(pt => pt.isTag).map(pt => pt.text);
      if (!tagsMatchSelection(tags, selectedTags)) {
        continue;
      }
      if (selectedDate !== null) {
        const resolvedDates = resolveSectionDates(section, entry.date);
        if (!dateMatchesSelection(resolvedDates, selectedDate)) {
          continue;
        }
      }
      result.push(section);
    }

    return result;
  }

  if (mode === 'search') {
    const query = searchQuery.toLowerCase();
    return sections.filter(section => section.toLowerCase().includes(query));
  }

  return sections;
}

/** 'upcoming' is the ToDo's tab: dated sections (future or past due) plus done entries. */
export type DateTab = 'all' | 'upcoming';

function hasDoneAt(entry: Entry): entry is Entry & { doneAt: number } {
  return typeof entry.doneAt === 'number' && Number.isFinite(entry.doneAt) && entry.doneAt > 0;
}

export function matchesDateTab(explicitDate: string | null, tab: DateTab, _todayIso: string): boolean {
  if (tab === 'all') return true;
  return explicitDate !== null;
}

export function sectionDateForTab(section: string, entry: Entry, entryLevelDate: string | null): string | null {
  if (entryLevelDate !== null) return entryLevelDate;
  return getExplicitSectionDate(section);
}

export function filterParagraphsForTab(
  entry: Entry,
  activeTab: DateTab,
  selectedTags: string[],
  selectedDate: string | null,
  searchQuery: string,
  todayIso: string
): string[] {
  if (activeTab === 'upcoming' && hasDoneAt(entry)) {
    const sections = filterParagraphsInEntry(entry, 'tag', selectedTags, '', selectedDate);
    const query = searchQuery.trim().toLowerCase();
    return query === '' ? sections : sections.filter(section => section.toLowerCase().includes(query));
  }

  const sections = splitSections(entry.text);
  const query = searchQuery.trim().toLowerCase();
  const lastIdx = sections.length - 1;
  const hasGlobalMeta = lastIdx >= 0 && isTagOnlySection(sections[lastIdx]);

  if (hasGlobalMeta) {
    const entryLevelTags = getEntryLevelTags(entry.text);
    const entryLevelDate = getEntryLevelDate(entry.text);
    const tagOk = selectedTags.length === 0 ? true : selectedTags.some(st => entryLevelTags.some(t => tagMatchesSelected(t, st)));
    if (tagOk) {
      return sections.filter(section => {
        if (!matchesDateTab(sectionDateForTab(section, entry, entryLevelDate), activeTab, todayIso)) {
          return false;
        }
        if (selectedDate !== null) {
          const resolvedDates = resolveSectionDates(section, entry.date);
          if (!dateMatchesSelection(resolvedDates, selectedDate)) {
            return false;
          }
        }
        if (query !== '' && !section.toLowerCase().includes(query)) {
          return false;
        }
        return true;
      });
    }
  }

  // Not (or not entirely) covered by the true trailing global tag/date
  // section: pair any other tag-only line with the content immediately
  // before it, same as filterParagraphsInEntry's 'tag' mode, plus AND the
  // tab-date and search checks.
  const remaining = hasGlobalMeta ? sections.slice(0, lastIdx) : sections;
  const { groups, leftover } = groupSectionsByTag(remaining);
  const result: string[] = [];

  for (const group of groups) {
    if (!tagsMatchSelection(group.tags, selectedTags)) {
      continue;
    }
    if (selectedDate !== null) {
      const dateOk = group.sections.some(section =>
        dateMatchesSelection(resolveSectionDates(section, entry.date), selectedDate)
      );
      if (!dateOk) {
        continue;
      }
    }
    const tabDateOk = group.sections.some(section =>
      matchesDateTab(sectionDateForTab(section, entry, null), activeTab, todayIso)
    );
    if (!tabDateOk) {
      continue;
    }
    if (query !== '' && !group.sections.some(s => s.toLowerCase().includes(query))) {
      continue;
    }
    result.push(...group.sections);
  }

  for (const section of leftover) {
    const parts = splitParts(section);
    const tags = parts.filter(pt => pt.isTag).map(pt => pt.text);
    if (!tagsMatchSelection(tags, selectedTags)) {
      continue;
    }
    if (selectedDate !== null) {
      const resolvedDates = resolveSectionDates(section, entry.date);
      if (!dateMatchesSelection(resolvedDates, selectedDate)) {
        continue;
      }
    }
    if (!matchesDateTab(sectionDateForTab(section, entry, null), activeTab, todayIso)) {
      continue;
    }
    if (query !== '' && !section.toLowerCase().includes(query)) {
      continue;
    }
    result.push(section);
  }

  return result;
}

export function filterEntriesForTab(
  entries: Entry[],
  activeTab: DateTab,
  selectedTags: string[],
  selectedDate: string | null,
  searchQuery: string,
  todayIso: string
): Entry[] {
  const withSortKey: { entry: Entry; sortKey: string }[] = [];

  for (const entry of entries) {
    if (activeTab === 'upcoming' && entry.archived) {
      continue;
    }
    const sections = filterParagraphsForTab(entry, activeTab, selectedTags, selectedDate, searchQuery, todayIso);
    if (sections.length === 0) {
      continue;
    }

    const entryLevelDate = getEntryLevelDate(entry.text);
    const qualifyingDates = sections
      .map(section => sectionDateForTab(section, entry, entryLevelDate))
      .filter((d): d is string => d !== null && matchesDateTab(d, activeTab, todayIso));

    if (qualifyingDates.length === 0 && !(activeTab === 'upcoming' && hasDoneAt(entry))) {
      continue;
    }

    const sortKey = qualifyingDates.length === 0 ? entry.date : qualifyingDates.reduce((min, d) => (d < min ? d : min));

    withSortKey.push({ entry, sortKey });
  }

  withSortKey.sort((a, b) => {
    if (a.sortKey !== b.sortKey) {
      return a.sortKey.localeCompare(b.sortKey);
    }
    if (a.entry.date !== b.entry.date) {
      return b.entry.date.localeCompare(a.entry.date);
    }
    return b.entry.time.localeCompare(a.entry.time);
  });

  return withSortKey.map(w => w.entry);
}
