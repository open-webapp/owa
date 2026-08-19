/**
 * @open-webapp/project-sync
 * Shared project organization + Drive backup/sync/restore for web apps.
 *
 * Public API types and main entry point.
 * Implementation follows the resolved decisions from the extraction plan.
 */

export type {
  ProjectSyncOptions,
  ProjectSync,
  Project,
  SyncDocument,
  SyncStatus,
  SyncPhase,
  Payload,
  DocumentState,
  ProjectFrom,
  SyncDocumentFrom,
} from './types.js';

export { createProjectSync } from './factory.js';
export { ProjectRegistry } from './registry.js';
export { DataStore, type DataStoreConfig } from './dataStore.js';
export { MigrationsManager } from './migrations.js';
export { SyncStateManager, type DocumentSyncState } from './syncState.js';
export { Scheduler, type SchedulerConfig } from './scheduler.js';
export { StatusObservable, type StatusCallback } from './status.js';

// Error taxonomy: re-export drive-sync errors + package-specific errors
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
  SyncConflictError,
  MergeError,
  DocumentStorageError,
  isDriveSyncError,
  needsReauth,
} from './errors.js';
