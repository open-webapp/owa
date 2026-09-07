/**
 * GoogleDriveWidget: presentational Drive connect/disconnect control.
 *
 * Reads live auth status from a `DriveAuthHandle` via `useDriveConnection` and
 * renders one of four states (disconnected / connected / needs-reauth / error).
 * Markup shape is ported from portfolio's `DriveRestorePanel` connect block and
 * notesdiary's `SettingsView` `section === 'drive'` block, restyled onto the
 * package's own `owa-drive-*` class vocabulary.
 *
 * Warm-up (`auth.activate()`) is host-driven (decision 25) — this component
 * only ever calls `auth.refresh()`, and swallows its rejections because the
 * handle already records failures into its status store.
 */

import { useEffect } from 'react';
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

  useEffect(() => {
    auth.refresh().catch(() => {});
  }, [auth]);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        auth.refresh().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [auth]);

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
