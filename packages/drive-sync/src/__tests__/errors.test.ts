import { describe, expect, it } from 'vitest';
import { DriveSyncError, NeedsReauthError, SyncTokenExpiredError } from '../index.js';

describe('SyncTokenExpiredError', () => {
  it('exports a structured sync token expiration error from the package entry', () => {
    const error = new SyncTokenExpiredError();

    expect(error).toBeInstanceOf(DriveSyncError);
    expect(error.name).toBe('SyncTokenExpiredError');
    expect(error.status).toBe(410);
    expect(error.reason).toBe('sync_token_expired');
  });

  it('does not signal that reauthentication is required', () => {
    expect(new SyncTokenExpiredError()).not.toBeInstanceOf(NeedsReauthError);
  });

  it('preserves a caller-supplied message', () => {
    const error = new SyncTokenExpiredError('Calendar sync token is no longer valid');

    expect(error.message).toBe('Calendar sync token is no longer valid');
  });
});
