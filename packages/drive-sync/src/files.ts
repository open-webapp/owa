import type { Logger } from './logger.js';
import type { FileRef } from './types.js';
import { driveFetch } from './http.js';
import { escapeQ } from './query.js';
import { NotFoundError } from './errors.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** Scopes this library always requests/requires. */
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

interface BaseCallOptions {
  appId: string;
  projectId: string;
  clientId: string;
  interactive?: boolean;
  logger?: Logger;
  fetchEmail?: (accessToken: string) => Promise<string>;
}

export interface ReadOptions extends BaseCallOptions {
  fileId: string;
}

/**
 * Fetches a file's content. Returns `null` on a 404 rather than throwing,
 * since Drive 404s both for a genuinely wrong id and for a file the
 * connected account cannot see — this ambiguity is documented in the public
 * API and callers are expected to treat `null` as "not available" rather
 * than distinguishing the two cases.
 */
export async function read(opts: ReadOptions): Promise<string | Blob | null> {
  try {
    const res = await driveFetch({
      appId: opts.appId,
      projectId: opts.projectId,
      clientId: opts.clientId,
      url: `${DRIVE_BASE}/files/${encodeURIComponent(opts.fileId)}?alt=media`,
      method: 'GET',
      interactive: opts.interactive,
      requiredScopes: REQUIRED_SCOPES,
      logger: opts.logger,
      fetchEmail: opts.fetchEmail,
    });

    const contentType = res.headers.get('Content-Type') ?? '';
    const isTextual =
      contentType === '' ||
      contentType.startsWith('text/') ||
      contentType.includes('application/json');

    return isTextual ? await res.text() : await res.blob();
  } catch (err) {
    if (err instanceof NotFoundError) {
      return null;
    }
    throw err;
  }
}

export interface RemoveOptions extends BaseCallOptions {
  fileId: string;
}

export async function remove(opts: RemoveOptions): Promise<void> {
  await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${DRIVE_BASE}/files/${encodeURIComponent(opts.fileId)}`,
    method: 'DELETE',
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
}

export interface WriteOptions extends BaseCallOptions {
  fileId?: string;
  folderId?: string;
  name?: string;
  content: string | Blob;
  mimeType: string;
}

function toBlob(content: string | Blob, mimeType: string): Blob {
  return content instanceof Blob ? content : new Blob([content], { type: mimeType });
}

async function updateContent(opts: WriteOptions, fileId: string): Promise<FileRef> {
  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media`,
    method: 'PATCH',
    headers: { 'Content-Type': opts.mimeType },
    body: opts.content,
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
  const json = (await res.json()) as { id: string; name?: string };
  return { id: json.id, name: json.name ?? opts.name };
}

/**
 * Creates or updates a file's content. Updates (fileId provided) use the
 * media-upload endpoint with the raw body. Creates use a `FormData`
 * multipart body — FormData + fetch computes and inserts its own boundary,
 * so file content that happens to contain a literal boundary-looking string
 * can never corrupt the request (a known bug in a hand-rolled-boundary
 * implementation this replaces).
 *
 * When no fileId is given but a name is, an existing non-trashed file with
 * that name (within `folderId`, when given) is looked up first and updated
 * in place. Without this, a caller that syncs by name — having no id to
 * hand back, e.g. on a fresh page load — would mint a brand-new Drive file
 * on every single sync instead of updating the file already in use.
 */
export async function write(opts: WriteOptions): Promise<FileRef> {
  if (opts.fileId) {
    return updateContent(opts, opts.fileId);
  }

  if (opts.name) {
    const existing = await list({
      appId: opts.appId,
      projectId: opts.projectId,
      clientId: opts.clientId,
      folderId: opts.folderId,
      nameEquals: opts.name,
      interactive: opts.interactive,
      logger: opts.logger,
      fetchEmail: opts.fetchEmail,
    });
    if (existing.length > 0) {
      return updateContent(opts, existing[0].id);
    }
  }

  const metadata: Record<string, unknown> = {
    name: opts.name,
    mimeType: opts.mimeType,
    parents: opts.folderId ? [opts.folderId] : undefined,
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('media', toBlob(opts.content, opts.mimeType));

  // Let the Fetch API's own Request serialize the FormData: this computes
  // and inserts a correct multipart boundary (never hand-rolled by us) and
  // exposes the resulting `Content-Type: multipart/form-data; boundary=...`
  // header, which we then forward explicitly alongside the serialized body.
  // This also makes the request body a plain string by the time it reaches
  // driveFetch, so environments (e.g. test fakes) that read the body via
  // `.text()` rather than re-driving a real network stack see the fully
  // encoded multipart payload rather than an opaque FormData object.
  const serialized = new Request('https://example.invalid/', { method: 'POST', body: form });
  const multipartContentType = serialized.headers.get('content-type') ?? undefined;
  const multipartBody = await serialized.text();

  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${UPLOAD_BASE}/files?uploadType=multipart&fields=id`,
    method: 'POST',
    headers: multipartContentType ? { 'Content-Type': multipartContentType } : undefined,
    body: multipartBody,
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
  const json = (await res.json()) as { id: string };
  return { id: json.id, name: opts.name };
}

export interface ListOptions extends BaseCallOptions {
  folderId?: string;
  mimeType?: string;
  nameEquals?: string;
}

function buildQuery(opts: ListOptions): string {
  const clauses: string[] = [];
  if (opts.folderId) {
    clauses.push(`'${escapeQ(opts.folderId)}' in parents`);
  }
  if (opts.mimeType) {
    clauses.push(`mimeType='${escapeQ(opts.mimeType)}'`);
  }
  if (opts.nameEquals) {
    clauses.push(`name='${escapeQ(opts.nameEquals)}'`);
  }
  clauses.push('trashed=false');
  return clauses.join(' and ');
}

export async function list(opts: ListOptions): Promise<FileRef[]> {
  const q = buildQuery(opts);
  const url = `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(
    'files(id,name,mimeType)'
  )}`;

  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url,
    method: 'GET',
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
  const json = (await res.json()) as { files?: FileRef[] };
  return json.files ?? [];
}

export interface EnsureFolderPathOptions extends BaseCallOptions {
  folderPath: string[];
}

/**
 * Creates a plain-JSON folder (no content, so this goes through the
 * non-upload /files endpoint) and returns its id.
 */
async function createFolder(
  opts: BaseCallOptions & { name: string; parentId?: string }
): Promise<string> {
  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${DRIVE_BASE}/files?fields=id`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: opts.name,
      mimeType: FOLDER_MIME_TYPE,
      parents: opts.parentId ? [opts.parentId] : undefined,
    }),
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
  const json = (await res.json()) as { id: string };
  return json.id;
}

/**
 * Walks `folderPath` level by level, creating any missing folder along the
 * way, and returns the leaf folder's id (never persisted by this library —
 * callers get it fresh on every call).
 *
 * Root-level (first path segment) lookup design choice: Drive's "My Drive"
 * root has no single well-known parent id that is safe to assume across
 * every account/Shared-Drive configuration, and this library only has the
 * `drive.file` scope (which only sees files/folders the app itself created
 * or that were explicitly shared with it) — so instead of trying to anchor
 * the first level under an assumed parent, we search WITHOUT a `... in
 * parents` clause for the first level (`mimeType='...folder' and name='...'
 * and trashed=false`), which finds the folder anywhere this app can see it.
 * Every subsequent level uses the previous level's resolved id as an
 * explicit `in parents` clause, which is unambiguous.
 */
export async function ensureFolderPath(opts: EnsureFolderPathOptions): Promise<string> {
  let parentId: string | undefined;

  for (const name of opts.folderPath) {
    const existing = await list({
      appId: opts.appId,
      projectId: opts.projectId,
      clientId: opts.clientId,
      interactive: opts.interactive,
      logger: opts.logger,
      fetchEmail: opts.fetchEmail,
      folderId: parentId,
      mimeType: FOLDER_MIME_TYPE,
      nameEquals: name,
    });

    if (existing.length > 0) {
      parentId = existing[0].id;
      continue;
    }

    parentId = await createFolder({
      appId: opts.appId,
      projectId: opts.projectId,
      clientId: opts.clientId,
      interactive: opts.interactive,
      logger: opts.logger,
      fetchEmail: opts.fetchEmail,
      name,
      parentId,
    });
  }

  if (!parentId) {
    // folderPath was empty — nothing to resolve. This should not happen for
    // a correctly-configured factory (folderPath is required and expected
    // to be non-empty), but guard rather than returning `undefined` as a
    // string.
    throw new Error('ensureFolderPath: folderPath must contain at least one segment');
  }

  return parentId;
}
