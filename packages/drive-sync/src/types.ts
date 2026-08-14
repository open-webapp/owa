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
