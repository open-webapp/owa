import type { Logger } from './logger.js';

export interface DriveSyncOptions {
  appId: string;
  clientId: string;
  folderPath: string[];
  logger?: Logger;
}

/**
 * Durable connection state returned by getConnection(). Survives token
 * expiry; does not contain any secret material.
 */
export interface Connection {
  email: string;
  needsReauth: boolean;
  expiresAt: number | null;
}

/**
 * Ephemeral access token state, stored separately from the durable
 * Connection record.
 */
export interface StoredToken {
  accessToken: string;
  expiresAt: number;
  grantedScopes: string[];
}

/** Representation of a Drive file reference. */
export interface FileRef {
  id: string;
  name?: string;
  /** Drive's monotonic change counter, when the call requested it. */
  version?: string;
  /** Drive's last-modified timestamp (RFC3339), when the call requested it. */
  modifiedTime?: string;
}

/**
 * Sync state of one file relative to what this client last restored.
 * Returned by `files.status()`.
 */
export interface FileState {
  fileId: string;
  /** False when the file is missing or not visible to the connected account. */
  exists: boolean;
  /** Version last restored/written by this client; null if never. */
  baseVersion: string | null;
  /** Version currently on Drive; null when the file does not exist. */
  remoteVersion: string | null;
  /** True when a write would be refused with a RemoteChangedError. */
  changedSinceRestore: boolean;
  remoteModifiedTime?: string;
  /** Epoch ms of the last restore/write by this client; null if never. */
  lastRestoredAt: number | null;
}

/** Drive permission shape as returned/accepted by the Drive Permissions API. */
export interface DrivePermission {
  id: string;
  type: 'user' | 'anyone';
  role: string;
  emailAddress?: string;
}

/** Google Workspace MIME type shorthands for common document types. */
export type WorkspaceMimeShorthand = 'docs' | 'sheets' | 'slides' | 'forms' | 'drawings';

/** Options for opening the Google Picker to select files. */
export interface PickFileOptions {
  apiKey: string;
  /**
   * Cloud project *number* of the OAuth client configured on
   * `DriveSyncOptions.clientId`. Passed to Picker's `setAppId()`; required
   * because drive-sync only ever holds a `drive.file`-scoped token.
   */
  appId: string;
  mimeTypes?: (string | WorkspaceMimeShorthand)[];
  multiSelect?: boolean;
  parentFolderId?: string;
}

/** File information returned after selection from Google Picker. */
export interface PickedFile {
  fileId: string;
  name: string;
  mimeType: string;
  content: string | Blob | null;
}

/** Options accepted on every Drive-op call site. */
export interface CallOptions {
  /** Whether an interactive (popup/redirect) auth flow may be triggered. Defaults to false. */
  interactive?: boolean;
}
