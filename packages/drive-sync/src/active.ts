/**
 * True when the app is in the foreground: the document is visible AND has
 * focus. With no `document` (Node, workers, SSR) the app is treated as active
 * so non-browser callers are never gated.
 */
export function isAppActive(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}
