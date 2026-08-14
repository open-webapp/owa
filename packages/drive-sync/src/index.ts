import type { Logger } from './logger.js';
import type { CallOptions, Connection, DriveSyncOptions, DrivePermission, FileRef, PickFileOptions, PickedFile } from './types.js';
import { noOpLogger } from './logger.js';
import { connect as connectImpl, getConnection as getConnectionImpl, disconnect as disconnectImpl, getAccessToken as getAccessTokenImpl } from './connection.js';
import { reconcile as reconcileImpl, dropProject as dropProjectImpl } from './reconcile.js';
import * as filesImpl from './files.js';
import * as permissionsImpl from './permissions.js';
import * as pickerImpl from './picker.js';
import { warmUpIfNeeded } from './refresh.js';
import { REQUIRED_SCOPES } from './files.js';
import { createBroadcast, type BroadcastMessage } from './broadcast.js';
import { evictDbHandle } from './storage.js';
import { notifyExternalTokenRefresh } from './token.js';

export type { DriveSyncOptions, Connection, StoredToken, FileRef, DrivePermission, CallOptions, WorkspaceMimeShorthand, PickFileOptions, PickedFile } from './types.js';
export * from './errors.js';

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Resolves the connected account's email from a freshly-acquired access
 * token. Implemented with a plain `fetch` (not `driveFetch`) because it is
 * authenticated with a token obtained moments earlier in the SAME connect()
 * call — there is no independent auth/retry concern here, so going through
 * driveFetch's own internal token acquisition would be redundant and wrong
 * (driveFetch always acquires its own token rather than accepting one).
 */
async function fetchEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch userinfo: ${res.status}`);
  }
  const json = (await res.json()) as { email?: string };
  if (!json.email) {
    throw new Error('userinfo response did not include an email');
  }
  return json.email;
}

/** Fire-and-forget revoke against Google's real token revocation endpoint. */
async function revokeToken(accessToken: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(accessToken)}`,
  });
}

export interface FilesHandle {
  list(opts?: {
    folderId?: string;
    mimeType?: string;
    nameEquals?: string;
  }, callOpts?: CallOptions): Promise<FileRef[]>;
  read(fileId: string, callOpts?: CallOptions): Promise<string | Blob | null>;
  write(opts: {
    fileId?: string;
    folderId?: string;
    name?: string;
    content: string | Blob;
    mimeType: string;
  }, callOpts?: CallOptions): Promise<FileRef>;
  remove(fileId: string, callOpts?: CallOptions): Promise<void>;
}

export interface PermissionsHandle {
  list(fileId: string, callOpts?: CallOptions): Promise<DrivePermission[]>;
  grant(opts: {
    fileId: string;
    type: 'user' | 'anyone';
    role: string;
    emailAddress?: string;
  }, callOpts?: CallOptions): Promise<DrivePermission>;
  update(opts: {
    fileId: string;
    permissionId: string;
    role: string;
  }, callOpts?: CallOptions): Promise<DrivePermission>;
  revoke(opts: { fileId: string; permissionId: string }, callOpts?: CallOptions): Promise<void>;
}

export interface ProjectHandle {
  connect(): Promise<Connection>;
  getConnection(): Promise<Connection | null>;
  disconnect(): Promise<void>;
  ensureFolderPath(): Promise<string>;
  /**
   * Raw OAuth access token, for handing directly to Google Picker
   * (`setOAuthToken()`) — see connection.ts's `getAccessToken` for why this
   * is the one exception to this library otherwise never exposing token
   * material. `interactive` defaults to true since callers use this to
   * drive a UI the user is actively interacting with.
   */
  getAccessToken(callOpts?: CallOptions): Promise<string>;
  pickFile(options: PickFileOptions): Promise<PickedFile[]>;
  files: FilesHandle;
  permissions: PermissionsHandle;
}

export interface DriveSync {
  activate(): () => void;
  reconcile(knownProjectIds: string[]): Promise<void>;
  dropProject(projectId: string): Promise<void>;
  project(projectId: string): ProjectHandle;
}

/**
 * Creates the drive-sync facade. `createDriveSync` itself attaches NO
 * listeners and makes NO network calls — everything is deferred until the
 * returned object's methods are actually called.
 */
export function createDriveSync(options: DriveSyncOptions): DriveSync {
  const { appId, clientId, folderPath } = options;
  const logger: Logger = options.logger ?? noOpLogger;

  /**
   * Design choice for `.activate()` (T30): the frozen public API's
   * `activate()` takes no project argument, but the actual background
   * token-refresh work (T29, refresh.ts) is inherently per-project. There is
   * no explicit registry of "active projects" anywhere in the frozen API
   * sketch, so this fills that gap by tracking, in this closure, every
   * projectId that `.project(id)` has ever been called with. `.activate()`
   * attaches exactly ONE global `visibilitychange`/`pageshow` listener pair
   * (not one pair per project); when either fires, the handler iterates
   * this live Set and runs refresh.ts's `warmUpIfNeeded` check for each
   * tracked project. Because the Set is read at event-fire time (not
   * snapshotted when `.activate()` is called), projects registered via
   * `.project(id)` AFTER `.activate()` runs are still covered — call order
   * between `.activate()` and `.project(id)` does not matter.
   */
  const trackedProjectIds = new Set<string>();

  function trackProject(projectId: string): void {
    trackedProjectIds.add(projectId);
  }

  /**
   * Handles a cross-tab broadcast (see broadcast.ts) received while active.
   * `logout`: another tab's disconnect() already cleared BOTH IndexedDB
   * records (connection + token) before broadcasting, and this tab's own
   * getConnection()/getToken() calls always read that same shared
   * IndexedDB directly, so there is no stale in-memory Connection/email
   * cache here to clear (index.ts, connection.ts, and refresh.ts hold no
   * such cache). The one piece of genuinely in-memory, per-tab state is
   * storage.ts's cached IDB *handle* — evicting it is a defensive no-op in
   * practice (reads against an already-open handle already see the other
   * tab's writes), but costs nothing and guards against any future
   * handle-level caching assumptions.
   * `token`: signals token.ts's per-tab in-flight-coalescing layer that a
   * fresh token now sits in shared storage, so the NEXT non-interactive
   * acquireToken() call for this project can skip its own GIS round-trip.
   */
  function handleBroadcast(msg: BroadcastMessage): void {
    if (msg.type === 'logout') {
      void evictDbHandle(appId, msg.projectId);
    } else if (msg.type === 'token') {
      notifyExternalTokenRefresh(msg.projectId);
    }
  }

  function activate(): () => void {
    const disposeBroadcast = createBroadcast(appId).onMessage(handleBroadcast);

    if (typeof document === 'undefined') {
      return disposeBroadcast;
    }

    const runWarmUps = (): void => {
      for (const projectId of trackedProjectIds) {
        void warmUpIfNeeded({ appId, projectId, clientId, fetchEmail, logger });
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return;
      runWarmUps();
    };

    const onPageShow = (event: Event): void => {
      const persisted = (event as PageTransitionEvent).persisted;
      if (!persisted) return;
      if (document.hidden) return;
      runWarmUps();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      disposeBroadcast();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
    };
  }

  function reconcile(knownProjectIds: string[]): Promise<void> {
    return reconcileImpl(appId, knownProjectIds);
  }

  function dropProject(projectId: string): Promise<void> {
    return dropProjectImpl(appId, projectId);
  }

  function project(projectId: string): ProjectHandle {
    trackProject(projectId);

    const base = { appId, projectId, clientId, logger, fetchEmail };

    const files: FilesHandle = {
      list(opts, callOpts) {
        return filesImpl.list({ ...base, ...opts, interactive: callOpts?.interactive });
      },
      read(fileId, callOpts) {
        return filesImpl.read({ ...base, fileId, interactive: callOpts?.interactive });
      },
      write(opts, callOpts) {
        return filesImpl.write({ ...base, ...opts, interactive: callOpts?.interactive });
      },
      remove(fileId, callOpts) {
        return filesImpl.remove({ ...base, fileId, interactive: callOpts?.interactive });
      },
    };

    const permissions: PermissionsHandle = {
      list(fileId, callOpts) {
        return permissionsImpl.list({ ...base, fileId, interactive: callOpts?.interactive });
      },
      grant(opts, callOpts) {
        return permissionsImpl.grant({ ...base, ...opts, interactive: callOpts?.interactive });
      },
      update(opts, callOpts) {
        return permissionsImpl.update({ ...base, ...opts, interactive: callOpts?.interactive });
      },
      revoke(opts, callOpts) {
        return permissionsImpl.revoke({ ...base, ...opts, interactive: callOpts?.interactive });
      },
    };

    return {
      connect() {
        return connectImpl({
          appId,
          projectId,
          clientId,
          scopes: REQUIRED_SCOPES,
          logger,
          fetchEmail,
        });
      },
      getConnection() {
        return getConnectionImpl({
          appId,
          projectId,
          requiredScopes: REQUIRED_SCOPES,
        });
      },
      async disconnect() {
        await disconnectImpl({
          appId,
          projectId,
          revokeFn: async (accessToken: string) => {
            try {
              await revokeToken(accessToken);
            } catch (err) {
              logger.warn('drive-sync: token revocation failed', { err });
            }
          },
        });
      },
      ensureFolderPath() {
        return filesImpl.ensureFolderPath({ ...base, folderPath });
      },
      getAccessToken(callOpts) {
        return getAccessTokenImpl({
          appId,
          projectId,
          clientId,
          scopes: REQUIRED_SCOPES,
          interactive: callOpts?.interactive ?? true,
          logger,
        });
      },
      async pickFile(options) {
        const token = await getAccessTokenImpl({
          appId,
          projectId,
          clientId,
          scopes: REQUIRED_SCOPES,
          interactive: true,
          logger,
        });
        const picked = await pickerImpl.openPicker({
          apiKey: options.apiKey,
          oauthToken: token,
          appId: options.appId,
          mimeTypes: options.mimeTypes,
          multiSelect: options.multiSelect,
          parentFolderId: options.parentFolderId,
        });
        const results: PickedFile[] = [];
        for (const p of picked) {
          const content = await filesImpl.read({ ...base, fileId: p.fileId, interactive: true });
          results.push({ fileId: p.fileId, name: p.name, mimeType: p.mimeType, content });
        }
        return results;
      },
      files,
      permissions,
    };
  }

  return {
    activate,
    reconcile,
    dropProject,
    project,
  };
}
