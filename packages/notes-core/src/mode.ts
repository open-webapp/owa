/**
 * View mode derivation logic for the Notes Diary app.
 */

export type ViewMode = 'all' | 'tag' | 'search';

/**
 * Derive the current view mode based on active filters.
 * Precedence: search > tag (includes date selection) > all
 * @param searchQuery - User's search input text
 * @param selectedTags - Array of selected tag names
 * @param selectedDate - ISO date string (YYYY-MM-DD) or null; treated as a filter trigger like tags
 */
export function deriveMode(searchQuery: string, selectedTags: string[], selectedDate: string | null = null): ViewMode {
  if (searchQuery.trim().length > 0) {
    return 'search';
  }
  if (selectedTags.length > 0 || selectedDate !== null) {
    return 'tag';
  }
  return 'all';
}
