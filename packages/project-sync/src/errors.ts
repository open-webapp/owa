/**
 * Error taxonomy for project-sync.
 *
 * Re-exports error types from drive-sync (our peer dependency) plus any
 * package-specific errors. Provides a unified error surface for apps.
 *
 * Decision 14: Package owns the error taxonomy. Apps never string-parse errors
 * (no parseSyncError-style code anywhere).
 */

// Re-export all error types from drive-sync so apps have a unified error surface.
export {
  DriveSyncError,
  type DriveSyncErrorOptions,
  NeedsReauthError,
  ScopeInsufficientError,
  WrongAccountError,
  type WrongAccountErrorOptions,
  NotFoundError,
  RateLimitedError,
  type RateLimitedErrorOptions,
  TransientError,
  RemoteChangedError,
  type RemoteChangedErrorOptions,
  GisLoadError,
  PickerCancelledError,
} from '@open-webapp/drive-sync';

/**
 * Thrown when sync conflict resolution failed after maximum retries.
 * Indicates conflicting edits that the merge function could not resolve
 * within 3 total write attempts (1 direct + up to 2 read-merge-write cycles).
 *
 * Decision 21: Bounded at 3 total write attempts.
 */
export class SyncConflictError extends Error {
  projectId?: string;
  docKey?: string;

  constructor(message = 'Sync conflict could not be resolved', context?: { projectId?: string; docKey?: string }) {
    super(message);
    this.name = 'SyncConflictError';
    this.projectId = context?.projectId;
    this.docKey = context?.docKey;
  }
}

/**
 * Thrown when a document merge fails (merge() throws an exception).
 * Carries the original error and document context.
 */
export class MergeError extends Error {
  projectId: string;
  docKey: string;
  originalError: Error;

  constructor(projectId: string, docKey: string, originalError: Error) {
    super(`Merge failed for document ${docKey}: ${originalError.message}`);
    this.name = 'MergeError';
    this.projectId = projectId;
    this.docKey = docKey;
    this.originalError = originalError;
  }
}

/**
 * Thrown when readLocal or writeLocal fails on a document.
 * Indicates app-level storage issues, not Drive sync issues.
 */
export class DocumentStorageError extends Error {
  projectId: string;
  docKey: string;
  originalError: Error;

  constructor(projectId: string, docKey: string, operation: 'read' | 'write', originalError: Error) {
    super(`Document ${operation} failed for ${docKey}: ${originalError.message}`);
    this.name = 'DocumentStorageError';
    this.projectId = projectId;
    this.docKey = docKey;
    this.originalError = originalError;
  }
}

/**
 * Type guard to check if an error is a typed drive-sync or project-sync error.
 * Useful for error handling that branches on error shape rather than message text.
 */
export function isDriveSyncError(err: unknown): err is Error & { name: string; status?: number } {
  return (
    err instanceof Error &&
    'name' in err &&
    (err.name === 'DriveSyncError' ||
      err.name === 'NeedsReauthError' ||
      err.name === 'ScopeInsufficientError' ||
      err.name === 'WrongAccountError' ||
      err.name === 'NotFoundError' ||
      err.name === 'RateLimitedError' ||
      err.name === 'TransientError' ||
      err.name === 'RemoteChangedError' ||
      err.name === 'GisLoadError' ||
      err.name === 'PickerCancelledError')
  );
}

/**
 * Type guard to check if an error requires re-authentication.
 */
export function needsReauth(err: unknown): boolean {
  if (err instanceof Error) {
    const name = 'name' in err ? err.name : '';
    return name === 'NeedsReauthError' || name === 'ScopeInsufficientError' || name === 'WrongAccountError';
  }
  return false;
}
