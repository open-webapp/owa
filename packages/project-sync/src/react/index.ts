/**
 * React hooks for @open-webapp/project-sync
 *
 * Provides:
 * - ProjectSyncProvider: context provider for ProjectSync instance
 * - useProjects(): hook to access all projects
 * - useActiveProject(): hook to access the active project
 * - useSyncStatus(): hook to access current sync status
 *
 * All hooks use useSyncExternalStore for efficient, subscription-based updates.
 * All are read-only; mutations go through the ProjectSync instance directly.
 *
 * Decision: no components exported, only hooks and provider.
 */

import React, {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
  type Context,
} from 'react';
import type { ProjectSync, Project, SyncStatus } from '../types.js';

/**
 * Context type for ProjectSync instance.
 */
interface ProjectSyncContextType {
  instance: ProjectSync;
}

/**
 * Create the context (private, not exported).
 */
const ProjectSyncContext: Context<ProjectSyncContextType | null> = createContext<ProjectSyncContextType | null>(
  null
);

/**
 * Error class for missing provider.
 */
class MissingProviderError extends Error {
  constructor(hookName: string) {
    super(`${hookName} must be used within <ProjectSyncProvider>`);
    this.name = 'MissingProviderError';
  }
}

/**
 * ProjectSyncProvider: wraps the application and provides ProjectSync instance
 * to all hooks via context.
 *
 * Usage:
 * ```tsx
 * <ProjectSyncProvider instance={projectSync}>
 *   <YourApp />
 * </ProjectSyncProvider>
 * ```
 */
export function ProjectSyncProvider({
  instance,
  children,
}: {
  instance: ProjectSync;
  children: ReactNode;
}): React.ReactElement {
  return React.createElement(
    ProjectSyncContext.Provider,
    { value: { instance } },
    children
  );
}

/**
 * Get the ProjectSync instance from context.
 * Throws a clear error if used outside of ProjectSyncProvider.
 */
function useProjectSyncInstance(): ProjectSync {
  const context = useContext(ProjectSyncContext);
  if (!context) {
    throw new MissingProviderError('useProjectSync hook');
  }
  return context.instance;
}

/**
 * Store wrapper for projects list.
 * Maintains a synchronous snapshot that can be read and updated.
 */
class ProjectsStore {
  private snapshot: Project[] = [];
  private listeners: Set<() => void> = new Set();

  setSnapshot(projects: Project[]): void {
    // Check if actually changed
    if (
      this.snapshot.length !== projects.length ||
      this.snapshot.some(
        (p, i) =>
          !projects[i] ||
          p.id !== projects[i].id ||
          p.name !== projects[i].name ||
          p.createdAt !== projects[i].createdAt
      )
    ) {
      this.snapshot = projects;
      this.notifyListeners();
    }
  }

  getSnapshot(): Project[] {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Store wrapper for active project.
 * Maintains a synchronous snapshot that can be read and updated.
 */
class ActiveProjectStore {
  private snapshot: Project | null = null;
  private listeners: Set<() => void> = new Set();

  setSnapshot(project: Project | null): void {
    // Check if actually changed
    const changed =
      this.snapshot === null && project !== null
        ? true
        : this.snapshot !== null && project === null
          ? true
          : this.snapshot &&
            project &&
            (this.snapshot.id !== project.id ||
              this.snapshot.name !== project.name ||
              this.snapshot.createdAt !== project.createdAt)
            ? true
            : false;

    if (changed) {
      this.snapshot = project;
      this.notifyListeners();
    }
  }

  getSnapshot(): Project | null {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Store wrapper for sync status.
 * Maintains a synchronous snapshot of the current sync status.
 */
class SyncStatusStore {
  private snapshot: SyncStatus | null = null;
  private listeners: Set<() => void> = new Set();
  private defaultSnapshot: SyncStatus = {
    phase: 'idle',
    lastSyncedAt: null,
    error: null,
    needsReauth: false,
    conflicts: [],
  };

  setSnapshot(status: SyncStatus): void {
    // StatusObservable already provides immutable snapshots, so we can do
    // referential equality check. If it's the same object, nothing changed.
    if (this.snapshot !== status) {
      this.snapshot = status;
      this.notifyListeners();
    }
  }

  getSnapshot(): SyncStatus {
    // Return the current snapshot, or default if not yet set
    // The default is cached to ensure referential stability
    return this.snapshot || this.defaultSnapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// Store singletons are created per-instance, keyed by instance reference
const projectsStoreMap = new WeakMap<ProjectSync, ProjectsStore>();
const activeProjectStoreMap = new WeakMap<ProjectSync, ActiveProjectStore>();
const syncStatusStoreMap = new WeakMap<ProjectSync, SyncStatusStore>();

function getProjectsStore(instance: ProjectSync): ProjectsStore {
  if (!projectsStoreMap.has(instance)) {
    projectsStoreMap.set(instance, new ProjectsStore());
  }
  return projectsStoreMap.get(instance)!;
}

function getActiveProjectStore(instance: ProjectSync): ActiveProjectStore {
  if (!activeProjectStoreMap.has(instance)) {
    activeProjectStoreMap.set(instance, new ActiveProjectStore());
  }
  return activeProjectStoreMap.get(instance)!;
}

function getSyncStatusStore(instance: ProjectSync): SyncStatusStore {
  if (!syncStatusStoreMap.has(instance)) {
    syncStatusStoreMap.set(instance, new SyncStatusStore());
  }
  return syncStatusStoreMap.get(instance)!;
}

/**
 * useProjects: returns the current list of all projects.
 *
 * Updates whenever a project is created, renamed, or removed.
 * Uses useSyncExternalStore for efficient subscription.
 *
 * Returns: Project[] (sorted by creation time)
 */
export function useProjects(): Project[] {
  const instance = useProjectSyncInstance();
  const store = getProjectsStore(instance);

  return useSyncExternalStore(
    // subscribe: set up listener and return unsubscribe function
    (onStoreChange) => {
      let isDestroyed = false;

      // Subscribe to store changes first, BEFORE fetching initial data
      // This ensures that when initial fetch completes and updates the store,
      // the store's change listener is already registered
      const unsubscribeStore = store.subscribe(onStoreChange);

      // Subscribe to status changes and refetch projects
      const unsubscribeStatus = instance.subscribe(() => {
        if (!isDestroyed) {
          instance.projects.list().then((projects) => {
            if (!isDestroyed) {
              store.setSnapshot(projects);
            }
          });
        }
      });

      // Initial fetch is already triggered by instance.subscribe() above,
      // which calls the callback immediately

      return () => {
        isDestroyed = true;
        unsubscribeStatus();
        unsubscribeStore();
      };
    },

    // getSnapshot: return the current projects snapshot
    () => store.getSnapshot(),

    // getServerSnapshot (optional, for SSR)
    () => []
  );
}

/**
 * useActiveProject: returns the currently active project or null.
 *
 * Updates whenever the active project changes.
 * Uses useSyncExternalStore for efficient subscription.
 *
 * Returns: Project | null
 */
export function useActiveProject(): Project | null {
  const instance = useProjectSyncInstance();
  const store = getActiveProjectStore(instance);

  return useSyncExternalStore(
    // subscribe
    (onStoreChange) => {
      let isDestroyed = false;

      // Subscribe to store changes first, BEFORE fetching initial data
      const unsubscribeStore = store.subscribe(onStoreChange);

      // Subscribe to status changes and refetch active project
      const unsubscribeStatus = instance.subscribe(() => {
        if (!isDestroyed) {
          instance.projects.getActive().then((project) => {
            if (!isDestroyed) {
              store.setSnapshot(project);
            }
          });
        }
      });

      // Initial fetch is already triggered by instance.subscribe() above,
      // which calls the callback immediately

      return () => {
        isDestroyed = true;
        unsubscribeStatus();
        unsubscribeStore();
      };
    },

    // getSnapshot
    () => store.getSnapshot(),

    // getServerSnapshot
    () => null
  );
}

/**
 * useSyncStatus: returns the current sync status.
 *
 * Updates whenever the sync status changes (phase, lastSyncedAt, error, etc.).
 * Uses useSyncExternalStore for efficient subscription.
 *
 * Returns: SyncStatus
 */
export function useSyncStatus(): SyncStatus {
  const instance = useProjectSyncInstance();
  const store = getSyncStatusStore(instance);

  return useSyncExternalStore(
    // subscribe: Set up listener and return unsubscribe function
    (onStoreChange) => {
      let isDestroyed = false;

      // Subscribe to store changes first, BEFORE subscribing to status observable
      // This ensures that when instance.subscribe() immediately calls the callback,
      // the store's change listener is already registered
      const unsubscribeStore = store.subscribe(onStoreChange);

      // Subscribe to status observable
      const unsubscribeStatus = instance.subscribe((status) => {
        if (!isDestroyed) {
          store.setSnapshot(status);
        }
      });

      return () => {
        isDestroyed = true;
        unsubscribeStatus();
        unsubscribeStore();
      };
    },

    // getSnapshot
    () => store.getSnapshot(),

    // getServerSnapshot
    () => ({
      phase: 'idle' as const,
      lastSyncedAt: null,
      error: null,
      needsReauth: false,
      conflicts: [],
    })
  );
}
