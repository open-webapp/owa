/**
 * Escapes a literal string for safe embedding inside a Drive `q=` search
 * parameter value, e.g. `name='...'`. Per Drive's query escaping rules,
 * backslashes must be escaped FIRST, then single quotes — escaping the quote
 * first would double-escape the backslashes just inserted for the quote.
 */
export function escapeQ(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
