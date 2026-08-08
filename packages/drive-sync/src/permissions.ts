import type { Logger } from './logger.js';
import type { DrivePermission } from './types.js';
import { driveFetch } from './http.js';
import { REQUIRED_SCOPES } from './files.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

interface BaseCallOptions {
  appId: string;
  projectId: string;
  clientId: string;
  interactive?: boolean;
  logger?: Logger;
  fetchEmail?: (accessToken: string) => Promise<string>;
}

export interface ListPermissionsOptions extends BaseCallOptions {
  fileId: string;
}

export async function list(opts: ListPermissionsOptions): Promise<DrivePermission[]> {
  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${DRIVE_BASE}/files/${encodeURIComponent(opts.fileId)}/permissions?fields=${encodeURIComponent(
      'permissions(id,type,role,emailAddress)'
    )}`,
    method: 'GET',
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
  const json = (await res.json()) as { permissions?: DrivePermission[] };
  return json.permissions ?? [];
}

export interface GrantPermissionOptions extends BaseCallOptions {
  fileId: string;
  type: 'user' | 'anyone';
  role: string;
  emailAddress?: string;
}

/**
 * Folds the old separate "createAnyonePermission" helper into a single
 * function keyed by `type`.
 */
export async function grant(opts: GrantPermissionOptions): Promise<DrivePermission> {
  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${DRIVE_BASE}/files/${encodeURIComponent(opts.fileId)}/permissions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: opts.type,
      role: opts.role,
      emailAddress: opts.type === 'user' ? opts.emailAddress : undefined,
    }),
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
  return (await res.json()) as DrivePermission;
}

export interface UpdatePermissionOptions extends BaseCallOptions {
  fileId: string;
  permissionId: string;
  role: string;
}

export async function update(opts: UpdatePermissionOptions): Promise<DrivePermission> {
  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${DRIVE_BASE}/files/${encodeURIComponent(opts.fileId)}/permissions/${encodeURIComponent(
      opts.permissionId
    )}`,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: opts.role }),
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
  return (await res.json()) as DrivePermission;
}

export interface RevokePermissionOptions extends BaseCallOptions {
  fileId: string;
  permissionId: string;
}

export async function revoke(opts: RevokePermissionOptions): Promise<void> {
  await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url: `${DRIVE_BASE}/files/${encodeURIComponent(opts.fileId)}/permissions/${encodeURIComponent(
      opts.permissionId
    )}`,
    method: 'DELETE',
    interactive: opts.interactive,
    requiredScopes: REQUIRED_SCOPES,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
  });
}
