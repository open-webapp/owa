/**
 * Factory function for creating ProjectSync instances.
 * Combines all the sub-modules (registry, dataStore, scheduler, status, etc.)
 * into the unified public API.
 */

import type { ProjectSyncOptions, ProjectSync, Project, SyncStatus, DocumentState } from './types.js';
import { ProjectRegistry } from './registry.js';
import { DataStore } from './dataStore.js';
import { MigrationsManager } from './migrations.js';
import { SyncStateManager } from './syncState.js';
import { Scheduler } from './scheduler.js';
import { StatusObservable } from './status.js';

export async function createProjectSync(options: ProjectSyncOptions): Promise<ProjectSync> {
  const registryDbName = options.registryDbName;

  const registry = new ProjectRegistry(registryDbName);
  await registry.init();

  const dataStore = new DataStore();
  const migrations = new MigrationsManager(registryDbName);
  await migrations.init();

  const syncState = new SyncStateManager(
    async () => registry.getDb(),
    registryDbName
  );
  await syncState.init();

  const status = new StatusObservable(options.drive);
  const scheduler = new Scheduler({
    interval: options.interval,
  });

  return {
    projects: {
      list: () => registry.list(),
      get: (id: string) => registry.get(id),
      create: (name: string) => registry.create(name),
      rename: (id: string, name: string) => registry.rename(id, name),
      remove: (id: string) => registry.remove(id),
      setActive: (id: string) => dataStore.setActive(id, options.data),
      getActive: async () => {
        const projectId = dataStore.getActiveProjectId();
        return projectId ? registry.get(projectId) : null;
      },
    },

    data: {
      getActiveDb: async () => dataStore.getActiveDb(),
      getDocumentState: async (projectId: string, docKey: string) =>
        syncState.getDocumentState(projectId, docKey),
      forgetDocument: async (projectId: string, docKey: string) =>
        syncState.forgetDocument(projectId, docKey),
    },

    connection: {
      connect: async () => {
        await options.drive.project('app').connect();
      },
      disconnect: async () => {
        await options.drive.project('app').disconnect();
      },
      status: async () => {
        const conn = options.drive.project('app').getConnection();
        return conn
          ? {
              email: (conn as any).email || '',
              needsReauth: (conn as any).needsReauth || false,
            }
          : null;
      },
    },

    sync: {
      start: () => scheduler.start(),
      stop: () => scheduler.stop(),
      syncNow: (projectId?: string) => scheduler.syncNow(projectId),
      markDirty: (projectId: string) => scheduler.markDirty(projectId),
    },

    subscribe: (callback: (status: SyncStatus) => void) => status.subscribe(callback),

    config: options,
  } as ProjectSync;
}
