// Pure module: Google Drive image-URL words + upload/token rules.
// No imports — no React, no drive package, no IndexedDB.

/**
 * Matches a Google Drive "file view" URL:
 *   https://drive.google.com/file/d/<id>/view
 * where <id> is [A-Za-z0-9_-]+. Tolerant of a trailing `?...` or `#...`.
 * Capture group 1 is the file id. Not global — safe to `.exec` repeatedly.
 */
export const DRIVE_IMAGE_URL_RE =
  /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/view(?:[?#][^\s)"'<>]*)?/;

/** Build the canonical Drive "file view" URL for a file id. */
export function buildDriveViewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/**
 * Parse a Drive image URL (e.g. an `<img src>` value). Returns `{ fileId }`
 * when `src` contains a Drive file-view URL, otherwise `null`.
 */
export function parseDriveImageUrl(
  src: string | undefined,
): { fileId: string } | null {
  if (!src) return null;
  const m = DRIVE_IMAGE_URL_RE.exec(src);
  if (!m) return null;
  return { fileId: m[1] };
}

/**
 * Extract every Drive image file id referenced from markdown image URLs in
 * `text`. Scans `![alt](url ...)` markdown images and bare Drive URLs,
 * left-to-right. Non-Drive image URLs are ignored. Result is deduped and
 * order-preserving (first occurrence wins).
 */
export function extractDriveImageFileIds(text: string): string[] {
  const ids: string[] = [];
  if (!text) return ids;

  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  // Alternation, scanned left-to-right, non-overlapping:
  //   1. markdown image  -> group 1 is its URL
  //   2. bare Drive URL  -> group 2 is the URL
  const re = new RegExp(
    '!\\[[^\\]]*\\]\\(\\s*([^)\\s]+)[^)]*\\)' +
      '|' +
      '(https:\\/\\/drive\\.google\\.com\\/file\\/d\\/[A-Za-z0-9_-]+\\/view(?:[?#][^\\s)"\'<>]*)?)',
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1] ?? m[2];
    if (!candidate) continue;
    const parsed = parseDriveImageUrl(candidate);
    if (parsed) push(parsed.fileId);
  }

  return ids;
}

/** MIME types accepted for image upload. */
export const ACCEPTED_IMAGE_MIME: Set<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** File extension (no dot) for each accepted MIME type. */
export const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Upload size cap: 5 MiB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** True when `type` is an accepted image MIME type. */
export function isAcceptedImageType(type: string): boolean {
  return ACCEPTED_IMAGE_MIME.has(type);
}

/** True when `size` (bytes) is within the upload size cap. */
export function isWithinSizeCap(size: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= MAX_IMAGE_BYTES;
}

/** ~6 lowercase alphanumeric chars ([a-z0-9]). */
export function shortRandomId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

/**
 * Slugify a base name: lowercase, non-alphanumeric runs -> `-`, collapse
 * repeats, trim leading/trailing `-`. Empty result falls back to `image`.
 */
export function slugifyBaseName(name: string): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'image';
}

/**
 * Build an upload filename: `<slug>-<shortRandom>.<ext>`. Any trailing
 * extension on `originalName` is dropped before slugifying. A missing or
 * blank name yields `image-<shortRandom>.<ext>`.
 */
export function buildUploadFilename(
  originalName: string | undefined,
  mime: string,
): string {
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  const rand = shortRandomId();
  if (!originalName || !originalName.trim()) {
    return `image-${rand}.${ext}`;
  }
  const withoutExt = originalName.replace(/\.[^.\/\\]+$/, '');
  const slug = slugifyBaseName(withoutExt);
  return `${slug}-${rand}.${ext}`;
}

/** Build the placeholder markdown token shown while an image uploads. */
export function buildUploadingToken(name: string, id: string): string {
  return `![${name}](uploading:${id})`;
}

/** Matches an uploading placeholder token: `![...](uploading:<id>)`. Not global. */
export const UPLOADING_TOKEN_RE = /!\[[^\]]*\]\(uploading:[A-Za-z0-9_-]+\)/;

/**
 * Replace an exact `token` inside `doc` with `replacement`, returning the new
 * doc plus the `[from, to)` character offsets the token occupied in the
 * original `doc`. Returns `null` if the token is absent, or occurs more than
 * once (used by the editor extension for a positioned CodeMirror dispatch).
 */
export function replaceUploadingToken(
  doc: string,
  token: string,
  replacement: string,
): { doc: string; from: number; to: number } | null {
  if (!token) return null;
  const from = doc.indexOf(token);
  if (from === -1) return null;
  const second = doc.indexOf(token, from + token.length);
  if (second !== -1) return null;
  const to = from + token.length;
  return {
    doc: doc.slice(0, from) + replacement + doc.slice(to),
    from,
    to,
  };
}

/**
 * Pure string op for PERSISTED entry text. If `text` does not contain `token`,
 * returns `text` byte-identical. Otherwise replaces every `token` occurrence
 * with `replacement ?? ''`; when the replacement is empty, collapses blank-line
 * runs the removal created and trims leftover leading/trailing newlines.
 * Never throws.
 */
export function reconcileTokenInText(
  text: string,
  token: string,
  replacement: string | null,
): string {
  try {
    if (!token || !text.includes(token)) return text;
    const repl = replacement ?? '';
    let out = text.split(token).join(repl);
    if (repl === '') {
      out = out.replace(/[ \t]+\n/g, '\n');
      out = out.replace(/\n{3,}/g, '\n\n');
      out = out.replace(/^\n+/, '');
      out = out.replace(/\n+$/, '');
    }
    return out;
  } catch {
    return text;
  }
}

/**
 * Pure string op for PERSISTED entry text. Removes EVERY markdown image
 * (`![alt](url ...)`) whose URL's parsed Drive file id equals `fileId`. Bare
 * (non-markdown) Drive URLs are left untouched. When something was removed, the
 * same blank-line cleanup as `reconcileTokenInText`'s removal branch is applied
 * (collapse blank-line runs, trim leading/trailing newlines). Returns `text`
 * byte-identical when `fileId` is absent or nothing matched. Never throws.
 */
export function removeDriveImageMarkdown(text: string, fileId: string): string {
  if (!text || !fileId) return text;
  try {
    const re = /!\[[^\]]*\]\([^)]*\)/g;
    let removedAny = false;
    const out = text.replace(re, (match) => {
      const inner = match.slice(match.indexOf('(') + 1, -1);
      const url = inner.trim().split(/\s+/)[0] ?? '';
      const parsed = parseDriveImageUrl(url);
      if (parsed && parsed.fileId === fileId) {
        removedAny = true;
        return '';
      }
      return match;
    });
    if (!removedAny) return text;
    return out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  } catch {
    return text;
  }
}
