/**
 * Tag parsing utilities for the Notes Diary app.
 */

import { isValidCalendarDate, parseFlexibleDate } from './dateUtils.js';

export { isValidCalendarDate };

export interface Part {
  text: string;
  isTag: boolean;
  isDate?: boolean;
  date?: string;
  isInvalidDate?: boolean;
}

/**
 * Regex to match date tokens in flexible formats at word boundaries.
 * Captures the token body (the part after @, before boundary).
 * Accepts 1-4 digits for each of year, month, day.
 * Requires exactly 2 separators, both '-' or both '/'.
 * (?![\d/-]) ensures no trailing digits or separators.
 */
export const SECTION_DATE_TOKEN_RE = /(?<=^|\s)@(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})(?![\d/-])/g;

/**
 * Regex to match tags.
 * First segment #[0-9A-Za-z][\w-]* — first char a digit or letter (not '_'),
 * then word chars / hyphens.
 * Optional colon groups (?::[\w-]+)* — zero or more, each a literal ':' plus
 * >=1 word/hyphen char. The colon is a literal character in a flat tag name,
 * NOT a hierarchy separator — no rollup, exact-match selection. A dangling ':'
 * or a '::' run is not consumed (#x: -> tag #x + plain ':'; #a::b -> tag #a +
 * plain '::b').
 * Optional /child continuation — one level (one slash). The child uses the
 * SAME segment grammar as the root: [0-9A-Za-z][\w-]*(?::[\w-]+)*, so a child
 * may start with a digit and carry colon groups (#work/123, #work/client:review).
 * A dangling slash, a child starting with '_' or ':' , or a dangling ':' is not
 * consumed (#work/1: -> tag #work/1 + plain ':').
 */
export const TAG_RE = /#[0-9A-Za-z][\w-]*(?::[\w-]+)*(?:\/[0-9A-Za-z][\w-]*(?::[\w-]+)*)?/g;

export interface DateToken {
  index: number;
  raw: string;
  iso: string;
}

interface RawDateToken {
  index: number;
  raw: string;
  body: string;
  iso: string | null;
}

/**
 * Scan text for all date tokens using SECTION_DATE_TOKEN_RE.
 * For each match: extract body (capture group 1), call parseFlexibleDate(body) to get iso (may be null).
 * Returns array of RawDateToken (even if iso is null — carry the signal for rendering).
 * This is the ONE place where the regex and parseFlexibleDate are paired.
 */
function scanDateTokens(text: string): RawDateToken[] {
  const regex = new RegExp(SECTION_DATE_TOKEN_RE.source, 'g');
  const tokens: RawDateToken[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const body = match[1];
    const iso = parseFlexibleDate(body);
    tokens.push({
      index: match.index,
      raw: match[0],
      body,
      iso,
    });
  }

  return tokens;
}

/**
 * Find the first accepted (valid calendar) date token in a section.
 * Returns {index, raw, iso} for the first valid match, or null if none found.
 */
export function findAcceptedDateToken(section: string): DateToken | null {
  const tokens = scanDateTokens(section);
  for (const token of tokens) {
    if (token.iso !== null) {
      return {
        index: token.index,
        raw: token.raw,
        iso: token.iso,
      };
    }
  }
  return null;
}

/**
 * Parse a section to extract the first valid date token.
 * Returns the ISO date string (YYYY-MM-DD) or null if no valid date found.
 */
export function parseSectionDate(section: string): string | null {
  const token = findAcceptedDateToken(section);
  return token ? token.iso : null;
}

/**
 * Thin wrapper around parseSectionDate, exported under a name that reads
 * naturally at tab-filtering call sites (vs. the rendering-flavored
 * parseSectionDate name). Same underlying logic, no duplication.
 */
export function getExplicitSectionDate(section: string): string | null {
  return parseSectionDate(section);
}

/**
 * Resolve the set of dates a section belongs to: the implicit entry date,
 * plus the section's accepted explicit @date token's ISO date (if any and
 * if different from the entry date). Deduped.
 */
export function resolveSectionDates(section: string, entryDate: string): string[] {
  const token = findAcceptedDateToken(section);
  if (token && token.iso !== entryDate) {
    return [entryDate, token.iso];
  }
  return [entryDate];
}

/**
 * Split text into parts: plain text and tags.
 * Tags must start with # followed by a letter, then word characters or hyphens.
 */
export function splitParts(text: string): Part[] {
  const regex = new RegExp(TAG_RE.source, 'g');
  const parts: Part[] = [];
  let lastIndex = 0;

  let match;
  while ((match = regex.exec(text)) !== null) {
    // Add text before the tag
    if (match.index > lastIndex) {
      parts.push({
        text: text.substring(lastIndex, match.index),
        isTag: false,
      });
    }

    // Add the tag
    parts.push({
      text: match[0],
      isTag: true,
    });

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      text: text.substring(lastIndex),
      isTag: false,
    });
  }

  // If no parts were found, return the entire text as non-tag
  if (parts.length === 0) {
    return [{ text, isTag: false }];
  }

  return parts;
}

/**
 * Split text into sections. A section is one or more consecutive non-blank
 * lines; a run of one or more blank lines separates sections. Internal line
 * breaks within a section are preserved. Leading/trailing blank lines are
 * trimmed and do not produce empty sections.
 */
export function splitSections(text: string): string[] {
  const lines = text.split('\n');
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        sections.push(current.join('\n'));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join('\n'));
  }

  return sections;
}

/**
 * Extract all tags from a text.
 */
export function extractTags(text: string): string[] {
  const parts = splitParts(text);
  return parts.filter(p => p.isTag).map(p => p.text);
}

export interface AutocompleteTagEntry {
  id: string;
  text: string;
  archived?: boolean;
}

/**
 * List unique active-entry tags without their leading # for autocomplete.
 */
export function listAutocompleteTags(entries: AutocompleteTagEntry[], prefix: string): string[] {
  const normalizedPrefix = prefix.toLowerCase();
  const tags = new Set<string>();

  for (const entry of entries) {
    if (entry.archived || entry.text.trim() === '') {
      continue;
    }

    for (const tag of extractTags(entry.text)) {
      const name = tag.slice(1);
      if (name.toLowerCase().startsWith(normalizedPrefix)) {
        tags.add(name);
      }
    }
  }

  return [...tags].sort();
}

/**
 * Check if a section contains only tags, date tokens, and whitespace (no
 * other text content). A trailing line like "#work @2024-01-15" carries no
 * prose of its own - only metadata - so it counts as tag-only same as a
 * plain "#work" line.
 */
export function isTagOnlySection(section: string): boolean {
  const withoutDateTokens = section.replace(SECTION_DATE_TOKEN_RE, '');
  const parts = splitParts(withoutDateTokens);
  return parts.every(part => {
    if (part.isTag) {
      return true;
    }
    // Non-tag part is tag-only if it's whitespace only
    return part.text.trim() === '';
  });
}

/**
 * Extract tags from the last section of text, if that section is tag-only.
 * Returns empty array if there are no sections, if the last section has non-tag content,
 * or if the text contains no tags in the last section.
 */
export function getEntryLevelTags(text: string): string[] {
  const sections = splitSections(text);
  if (sections.length === 0) {
    return [];
  }
  const last = sections[sections.length - 1];
  if (!isTagOnlySection(last)) {
    return [];
  }
  return extractTags(last);
}

/**
 * Extract the explicit date from the last section of text, if that section
 * is tag/date-only (metadata-only). Returns null if there are no sections,
 * if the last section has non-metadata content, or if it has no date token.
 */
export function getEntryLevelDate(text: string): string | null {
  const sections = splitSections(text);
  if (sections.length === 0) {
    return null;
  }
  const last = sections[sections.length - 1];
  if (!isTagOnlySection(last)) {
    return null;
  }
  return getExplicitSectionDate(last);
}

/**
 * State object to track whether a date has already been emitted in splitPartsWithDate.
 * Shared across multiple calls to ensure a date is only marked once.
 */
export interface AlreadyEmitted {
  done: boolean;
  /** Text node that claimed the pill; a re-render of that same node (StrictMode) may emit it again. */
  ownerText?: string;
}

/**
 * Split text into parts: plain text, tags, and optionally a date.
 * Takes explicit acceptedIso (NOT re-derived from text).
 * Collects tag matches + date matches (both valid and invalid).
 * For invalid dates (isInvalidDate), always marks with isInvalidDate: true.
 * For valid dates: if iso === acceptedIso and alreadyEmitted.done === false,
 * flag it isDate:true, set alreadyEmitted.done = true. Later valid dates stay inert.
 * Emitted-flag is shared across calls with same acceptedIso → date part only on FIRST call.
 */
export function splitPartsWithDate(
  text: string,
  acceptedIso: string | null,
  alreadyEmitted?: AlreadyEmitted
): Part[] {
  const tagRegex = new RegExp(TAG_RE.source, 'g');
  const positions: Array<{
    index: number;
    length: number;
    type: 'tag' | 'date';
    part: Part;
  }> = [];

  // Find all tags
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    positions.push({
      index: match.index,
      length: match[0].length,
      type: 'tag',
      part: { text: match[0], isTag: true },
    });
  }

  // Find all date tokens
  const tokens = scanDateTokens(text);
  const state = alreadyEmitted || { done: false };

  for (const token of tokens) {
    let part: Part;

    if (token.iso === null) {
      // Invalid date: always mark with isInvalidDate: true
      part = {
        text: token.raw,
        isTag: false,
        isInvalidDate: true,
      };
    } else if (token.iso === acceptedIso && !state.done) {
      // Valid date that matches acceptedIso and not yet emitted
      state.done = true;
      part = {
        text: token.raw,
        isTag: false,
        isDate: true,
        date: token.iso,
      };
    } else {
      // Valid date but doesn't match acceptedIso or already emitted
      part = {
        text: token.raw,
        isTag: false,
      };
    }

    positions.push({
      index: token.index,
      length: token.raw.length,
      type: 'date',
      part,
    });
  }

  // Sort by index
  positions.sort((a, b) => a.index - b.index);

  // Build parts array
  const parts: Part[] = [];
  let lastIndex = 0;

  for (const pos of positions) {
    // Add text before this token
    if (pos.index > lastIndex) {
      parts.push({
        text: text.substring(lastIndex, pos.index),
        isTag: false,
      });
    }

    // Add the token
    parts.push(pos.part);
    lastIndex = pos.index + pos.length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      text: text.substring(lastIndex),
      isTag: false,
    });
  }

  // If no parts were found, return the entire text as non-tag
  if (parts.length === 0) {
    return [{ text, isTag: false }];
  }

  return parts;
}
