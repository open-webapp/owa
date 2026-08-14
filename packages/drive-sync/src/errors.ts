/**
 * Typed error classes for drive-sync. All carry structured fields (status,
 * reason, email, fileId, retryAfter, etc.) rather than baking the only
 * available information into a formatted message string, so callers can
 * branch on error shape without string-parsing.
 */

export interface DriveSyncErrorOptions {
  status?: number;
  reason?: string;
}

export class DriveSyncError extends Error {
  status?: number;
  reason?: string;

  constructor(message: string, opts?: DriveSyncErrorOptions) {
    super(message);
    this.name = 'DriveSyncError';
    this.status = opts?.status;
    this.reason = opts?.reason;
  }
}

/**
 * Thrown when no usable token exists and the requested call is
 * non-interactive (so no popup/redirect flow may be triggered to obtain one).
 */
export class NeedsReauthError extends DriveSyncError {
  constructor(message = 'Reauthentication required', opts?: DriveSyncErrorOptions) {
    super(message, opts);
    this.name = 'NeedsReauthError';
  }
}

/**
 * Thrown on a 403 response with reason ACCESS_TOKEN_SCOPE_INSUFFICIENT.
 */
export class ScopeInsufficientError extends DriveSyncError {
  constructor(message = 'Access token has insufficient scope', opts?: DriveSyncErrorOptions) {
    super(message, { status: 403, reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', ...opts });
    this.name = 'ScopeInsufficientError';
  }
}

export interface WrongAccountErrorOptions extends DriveSyncErrorOptions {
  expectedEmail: string;
  actualEmail?: string;
}

/**
 * Thrown when the authenticated account does not match the expected one
 * (e.g. a silent refresh returned a token for a different Google account).
 */
export class WrongAccountError extends DriveSyncError {
  expectedEmail: string;
  actualEmail?: string;
  /** Convenience alias mirroring the spec's `this.email` field (== actualEmail). */
  email?: string;

  constructor(opts: WrongAccountErrorOptions) {
    super(
      `Wrong account: expected ${opts.expectedEmail}${
        opts.actualEmail ? `, got ${opts.actualEmail}` : ''
      }`,
      opts
    );
    this.name = 'WrongAccountError';
    this.expectedEmail = opts.expectedEmail;
    this.actualEmail = opts.actualEmail;
    this.email = opts.actualEmail;
  }
}

/** Thrown when a Drive file lookup returns 404. */
export class NotFoundError extends DriveSyncError {
  fileId: string;

  constructor(fileId: string, opts?: DriveSyncErrorOptions) {
    super(`File not found: ${fileId}`, { status: 404, ...opts });
    this.name = 'NotFoundError';
    this.fileId = fileId;
  }
}

export interface RateLimitedErrorOptions extends DriveSyncErrorOptions {
  retryAfter?: number;
}

/** Thrown on a 429 response. */
export class RateLimitedError extends DriveSyncError {
  retryAfter?: number;

  constructor(opts?: RateLimitedErrorOptions) {
    super('Rate limited', { status: 429, ...opts });
    this.name = 'RateLimitedError';
    this.retryAfter = opts?.retryAfter;
  }
}

/** Generic 5xx-after-retries failure. */
export class TransientError extends DriveSyncError {
  constructor(message = 'Transient upstream error', opts?: DriveSyncErrorOptions) {
    super(message, opts);
    this.name = 'TransientError';
  }
}

/** Thrown when the Google Identity Services script never loaded within the timeout. */
export class GisLoadError extends Error {
  constructor(message = 'Google Identity Services failed to load in time') {
    super(message);
    this.name = 'GisLoadError';
  }
}

/** Thrown when the user cancels the Google Picker dialog. */
export class PickerCancelledError extends DriveSyncError {
  constructor(message = 'User cancelled the picker', opts?: DriveSyncErrorOptions) {
    super(message, opts);
    this.name = 'PickerCancelledError';
  }
}
