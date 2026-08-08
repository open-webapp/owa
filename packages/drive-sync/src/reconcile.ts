import { evictDbHandle } from './storage.js';

function dbPrefix(appId: string): string {
  return `owa-drive-${appId}-`;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = (): void => resolve();
    request.onerror = (): void => reject(request.error ?? new Error(`Failed to delete database ${name}`));
    request.onblocked = (): void => resolve();
  });
}

/**
 * Safety-net cleanup: enumerate all owa-drive databases for this appId and
 * delete any whose projectId is not in knownProjectIds. No-ops if
 * indexedDB.databases() is unsupported (e.g. Firefox, older Safari).
 */
export async function reconcile(
  appId: string,
  knownProjectIds: string[]
): Promise<void> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return;
  }

  const prefix = dbPrefix(appId);
  const known = new Set(knownProjectIds);
  const databases = await indexedDB.databases();

  for (const { name } of databases) {
    if (!name || !name.startsWith(prefix)) {
      continue;
    }
    const projectId = name.slice(prefix.length);
    if (!known.has(projectId)) {
      await evictDbHandle(appId, projectId);
      await deleteDatabase(name);
    }
  }
}

/**
 * Primary cleanup path: eagerly delete one specific project's database.
 * Apps should call this directly when a project is removed rather than
 * relying on reconcile() as the only mechanism.
 */
export async function dropProject(appId: string, projectId: string): Promise<void> {
  await evictDbHandle(appId, projectId);
  const name = `${dbPrefix(appId)}${projectId}`;
  await deleteDatabase(name);
}
