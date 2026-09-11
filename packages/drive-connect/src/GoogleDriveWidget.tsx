/**
 * GoogleDriveWidget: presentational Drive connect/disconnect control.
 *
 * Reads live auth status from a `DriveAuthHandle` via `useDriveConnection`,
 * which fans in drive-sync's `subscribeConnection` snapshot plus the local
 * overlay, and renders one of four states (disconnected / connected /
 * needs-reauth / error). Markup shape is ported from portfolio's
 * `DriveRestorePanel` connect block and notesdiary's `SettingsView`
 * `section === 'drive'` block, restyled onto the package's own
 * `owa-drive-*` class vocabulary.
 *
 * Warm-up and visibility-driven refresh are handled by drive-sync's
 * `activate()`, wired up by the host outside this package — this widget
 * never re-reads status on mount or on visibility change; it only renders
 * whatever `useDriveConnection` currently reports.
 */

import type { GoogleDriveWidgetProps } from './types.js';
import { useDriveConnection } from './useDriveConnection.js';

const cx = (pkg: string, host?: string) => (host ? `${host} ${pkg}` : pkg);

export function GoogleDriveWidget({
  auth,
  onConnected,
  onDisconnected,
  classNames,
  description,
}: GoogleDriveWidgetProps) {
  const { connected, email, connecting, error, needsReauth } = useDriveConnection(auth);

  const handleConnect = async () => {
    try {
      const conn = await auth.connect();
      onConnected?.(conn);
    } catch {
      /* store holds the error */
    }
  };

  const handleDisconnect = async () => {
    try {
      await auth.disconnect();
      onDisconnected?.();
    } catch {
      /* store holds the error */
    }
  };

  return (
    <div className={cx('owa-drive-root', classNames?.root)}>
      {!connected && !needsReauth && (
        <button
          type="button"
          className={cx('owa-drive-connect', classNames?.connectButton)}
          disabled={connecting}
          onClick={handleConnect}
        >
          {connecting ? 'Connecting…' : 'Connect Google Drive'}
        </button>
      )}

      {connected && !needsReauth && (
        <>
          <p className={cx('owa-drive-status', classNames?.status)}>
            Connected as{' '}
            <span className={cx('owa-drive-email', classNames?.email)}>{email}</span>
          </p>
          <button
            type="button"
            className={cx('owa-drive-disconnect', classNames?.disconnectButton)}
            disabled={connecting}
            onClick={handleDisconnect}
          >
            Disconnect
          </button>
        </>
      )}

      {connected && needsReauth && (
        <div className={cx('owa-drive-reauth', classNames?.reauth)}>
          Reconnect to restore sync
          <button
            type="button"
            className={cx('owa-drive-connect', classNames?.connectButton)}
            disabled={connecting}
            onClick={handleConnect}
          >
            Reconnect
          </button>
        </div>
      )}

      {error && (
        <p className={cx('owa-drive-error', classNames?.error)} role="alert">
          {error}
        </p>
      )}

      {description != null && (
        <div className={cx('owa-drive-description', classNames?.description)}>{description}</div>
      )}
    </div>
  );
}
