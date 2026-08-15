import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { StoredToken } from './types.js';

/** Durable connection record persisted under the 'conn' key of the auth store. */
export interface ConnRecord {
  email: string;
  grantedScopes: string[];
  connectedAt: number;
}

/**
 * Per-file sync baseline: the Drive `version` this client last restored (via
 * files.read()) or last successfully wrote. A write is only allowed when the
 * file's current remote version still matches this — see files.ts.
 */
export interface FileStateRecord {
  fileId: string;
  version: string;
  /** Epoch ms at which this baseline was recorded. */
  syncedAt: number;
}

interface AuthDbSchema extends DBSchema {
  auth: {
    key: string;
    value: ConnRecord | StoredToken;
  };
  files: {
    key: string;
    value: FileStateRecord;
  };
}

const AUTH_STORE = 'auth';
const FILES_STORE = 'files';
const CONN_KEY = 'conn';
const TOKEN_KEY = 'token';

function dbName(appId: string, projectId: string): string {
  return `owa-drive-${appId}-${projectId}`;
}

function cacheKey(appId: string, projectId: string): string {
  return `${appId}:${projectId}`;
}

const dbCache = new Map<string, Promise<IDBPDatabase<AuthDbSchema>>>();

export function openAuthDb(
  appId: string,
  projectId: string
): Promise<IDBPDatabase<AuthDbSchema>> {
  const key = cacheKey(appId, projectId);
  let handle = dbCache.get(key);
  if (!handle) {
    // v2 added the 'files' store for per-file sync baselines. The upgrade is
    // additive and each createObjectStore is guarded, so a v1 database opens
    // at v2 by gaining the new store and keeps its existing auth records.
    handle = openDB<AuthDbSchema>(dbName(appId, projectId), 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(AUTH_STORE)) {
          db.createObjectStore(AUTH_STORE);
        }
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE);
        }
      },
    });
    dbCache.set(key, handle);
  }
  return handle;
}

/**
 * Evict a cached DB handle from the in-memory cache (and close it if open).
 * Does not delete the underlying IndexedDB database — see reconcile.ts for that.
 */
export async function evictDbHandle(
  appId: string,
  projectId: string
): Promise<void> {
  const key = cacheKey(appId, projectId);
  const handle = dbCache.get(key);
  dbCache.delete(key);
  if (handle) {
    try {
      const db = await handle;
      db.close();
    } catch {
      // Ignore errors closing an already-broken handle.
    }
  }
}

export async function getConn(
  appId: string,
  projectId: string
): Promise<ConnRecord | undefined> {
  const db = await openAuthDb(appId, projectId);
  const value = await db.get(AUTH_STORE, CONN_KEY);
  return value as ConnRecord | undefined;
}

export async function setConn(
  appId: string,
  projectId: string,
  conn: ConnRecord
): Promise<void> {
  const db = await openAuthDb(appId, projectId);
  await db.put(AUTH_STORE, conn, CONN_KEY);
}

export async function clearConn(appId: string, projectId: string): Promise<void> {
  const db = await openAuthDb(appId, projectId);
  await db.delete(AUTH_STORE, CONN_KEY);
}

export async function getToken(
  appId: string,
  projectId: string
): Promise<StoredToken | undefined> {
  const db = await openAuthDb(appId, projectId);
  const value = await db.get(AUTH_STORE, TOKEN_KEY);
  return value as StoredToken | undefined;
}

export async function setToken(
  appId: string,
  projectId: string,
  token: StoredToken
): Promise<void> {
  const db = await openAuthDb(appId, projectId);
  await db.put(AUTH_STORE, token, TOKEN_KEY);
}

export async function clearToken(appId: string, projectId: string): Promise<void> {
  const db = await openAuthDb(appId, projectId);
  await db.delete(AUTH_STORE, TOKEN_KEY);
}

export async function getFileState(
  appId: string,
  projectId: string,
  fileId: string
): Promise<FileStateRecord | undefined> {
  const db = await openAuthDb(appId, projectId);
  return db.get(FILES_STORE, fileId);
}

export async function setFileState(
  appId: string,
  projectId: string,
  state: FileStateRecord
): Promise<void> {
  const db = await openAuthDb(appId, projectId);
  await db.put(FILES_STORE, state, state.fileId);
}

export async function clearFileState(
  appId: string,
  projectId: string,
  fileId: string
): Promise<void> {
  const db = await openAuthDb(appId, projectId);
  await db.delete(FILES_STORE, fileId);
}
