/**
 * Sync scheduling orchestration — interval, visibility regain, debounce, single-flight, cross-tab leader election.
 *
 * Implements decision 14:
 * - Interval-based syncing (null = manual only)
 * - Sync on visibility regain (tab becomes visible after hidden)
 * - Debounced markDirty(projectId) to batch rapid changes
 * - Single-flight per project: overlapping syncNow() calls return the same promise
 * - Cross-tab leader election via BroadcastChannel so only one tab runs interval syncs
 * - No zombie timers: stop() cleans up all state
 */

/**
 * Callback signature for sync operations.
 * @param projectId - Project to sync, or undefined to sync all projects
 * @returns Promise that resolves when sync completes
 */
export type SyncFn = (projectId?: string) => Promise<void>;

/**
 * Configuration for the Scheduler.
 */
export interface SchedulerConfig {
  /**
   * Sync interval in milliseconds, or null for manual-only mode.
   */
  interval: number | null;

  /**
   * Debounce delay for markDirty() in milliseconds.
   * Defaults to 500ms.
   */
  dirtyDebounceMs?: number;

  /**
   * Optional logger for debugging.
   */
  logger?: {
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: unknown): void;
  };
}

/**
 * Manages sync scheduling with interval, visibility detection, debounce, single-flight, and cross-tab coordination.
 */
export class Scheduler {
  private syncFn: SyncFn | null = null;
  private interval: number | null;
  private dirtyDebounceMs: number;
  private logger: SchedulerConfig['logger'];

  // Interval timer state
  private intervalTimerId: ReturnType<typeof setInterval> | null = null;
  private isStarted = false;

  // Single-flight per project
  private inFlightSyncs: Map<string, Promise<void>> = new Map();

  // Debounce state per project
  private dirtyProjects: Set<string> = new Set();
  private dirtyDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Visibility detection
  private visibilityListener: ((e: Event) => void) | null = null;
  private wasHiddenLastCheck = false;

  // Cross-tab leader election
  private broadcastChannel: BroadcastChannel | null = null;
  private isLeader = false;
  private leaderCheckTimer: ReturnType<typeof setInterval> | null = null;
  private instanceId: string;

  constructor(config: SchedulerConfig) {
    this.interval = config.interval;
    this.dirtyDebounceMs = config.dirtyDebounceMs ?? 500;
    this.logger = config.logger;
    this.instanceId = Math.random().toString(36).substring(2, 11);

    this.setupBroadcastChannel();
    this.setupVisibilityListener();
  }

  /**
   * Set the sync function. Must be called before start().
   */
  setSyncFn(fn: SyncFn): void {
    this.syncFn = fn;
  }

  /**
   * Start the scheduler (if an interval was provided).
   * Becomes leader if using BroadcastChannel, or sole leader if BroadcastChannel unavailable.
   */
  start(): void {
    if (this.isStarted) {
      this.log('warn', 'Scheduler already started');
      return;
    }

    if (!this.syncFn) {
      this.log('warn', 'Scheduler.start() called before setSyncFn()');
      return;
    }

    this.isStarted = true;
    this.log('info', 'Scheduler started');

    // Assume leadership initially; if BroadcastChannel exists, run election
    this.isLeader = true;

    if (this.broadcastChannel) {
      // Announce our existence for cross-tab coordination
      this.broadcastChannel.postMessage({ type: 'instance-start', instanceId: this.instanceId });
      // Run election to find the true leader
      this.runLeaderElection();
    }

    // If interval-based, start the timer
    if (this.interval !== null) {
      this.startIntervalTimer();
    }
  }

  /**
   * Stop the scheduler.
   * Clears all timers and debounces. Does not affect in-flight syncs.
   */
  stop(): void {
    if (!this.isStarted) {
      this.log('warn', 'Scheduler not started');
      return;
    }

    this.isStarted = false;
    this.log('info', 'Scheduler stopped');

    // Clear interval timer
    if (this.intervalTimerId !== null) {
      clearInterval(this.intervalTimerId);
      this.intervalTimerId = null;
    }

    // Clear all debounce timers
    for (const [projectId, timerId] of this.dirtyDebounceTimers.entries()) {
      clearTimeout(timerId);
    }
    this.dirtyDebounceTimers.clear();
    this.dirtyProjects.clear();

    // Clear leader check timer
    if (this.leaderCheckTimer !== null) {
      clearInterval(this.leaderCheckTimer);
      this.leaderCheckTimer = null;
    }

    // Announce departure (if BroadcastChannel is available)
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'instance-stop',
        instanceId: this.instanceId,
      });
    }

    this.isLeader = false;
  }

  /**
   * Trigger an immediate sync for one project or all.
   * If a sync is already in flight for the project, returns the existing promise.
   * Single-flight per project.
   *
   * @param projectId - Project to sync, or undefined to sync all projects
   * @returns Promise that resolves when sync completes
   */
  syncNow(projectId?: string): Promise<void> {
    if (!this.isStarted) {
      this.log('warn', 'syncNow() called before scheduler started');
    }

    if (!this.syncFn) {
      throw new Error('Scheduler.setSyncFn() not called');
    }

    const syncKey = projectId ?? '__all__';

    // Check single-flight
    const existing = this.inFlightSyncs.get(syncKey);
    if (existing) {
      this.log('debug', `Reusing in-flight sync for project ${projectId ?? 'all'}`);
      return existing;
    }

    // Create the promise and track it
    const promise = this.performSync(projectId)
      .catch((err) => {
        // Log the error but re-throw so callers see it
        this.log('error', `Sync failed for project ${projectId ?? 'all'}`, err);
        throw err;
      })
      .finally(() => {
        this.inFlightSyncs.delete(syncKey);
      });

    this.inFlightSyncs.set(syncKey, promise);
    return promise;
  }

  /**
   * Mark a project as dirty to trigger sync after debounce.
   * Multiple calls within the debounce window = one sync.
   *
   * @param projectId - Project to mark dirty
   */
  markDirty(projectId: string): void {
    if (!this.isStarted) {
      this.log('debug', `markDirty() called before scheduler started for project ${projectId}`);
    }

    // Cancel existing debounce timer for this project
    const existingTimer = this.dirtyDebounceTimers.get(projectId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    // Mark as dirty
    this.dirtyProjects.add(projectId);

    // Schedule a sync after debounce
    const timerId = setTimeout(async () => {
      this.dirtyDebounceTimers.delete(projectId);
      this.dirtyProjects.delete(projectId);

      // Trigger sync for this project
      try {
        await this.syncNow(projectId);
      } catch (err) {
        this.log('error', `Error syncing dirty project ${projectId}`, err);
      }
    }, this.dirtyDebounceMs);

    this.dirtyDebounceTimers.set(projectId, timerId);
  }

  /**
   * Check if the scheduler is running.
   */
  isRunning(): boolean {
    return this.isStarted;
  }

  /**
   * Check if this instance is the cross-tab leader.
   * Only the leader runs interval syncs.
   */
  getIsLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Disconnect and clean up (called by ProjectSync on disconnect).
   * Stops the scheduler if running.
   */
  disconnect(): void {
    if (this.isStarted) {
      this.stop();
    }

    // Clean up BroadcastChannel
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch (err) {
        // Ignore close errors
      }
      this.broadcastChannel = null;
    }

    // Clean up visibility listener
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private setupBroadcastChannel(): void {
    try {
      this.broadcastChannel = new BroadcastChannel('project-sync-scheduler');
      this.broadcastChannel.onmessage = (event) => {
        this.handleBroadcastMessage(event.data);
      };
    } catch (err) {
      // BroadcastChannel not available (older browsers or restricted context)
      this.log('info', 'BroadcastChannel not available, running in single-tab mode');
      this.isLeader = true;
    }
  }

  private setupVisibilityListener(): void {
    this.visibilityListener = () => {
      this.handleVisibilityChange();
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  private handleBroadcastMessage(message: any): void {
    switch (message.type) {
      case 'instance-start': {
        // Another tab started. Run leader election immediately.
        // The tab with smallest instanceId wins.
        if (this.broadcastChannel && message.instanceId) {
          if (message.instanceId < this.instanceId && this.isLeader) {
            this.cedeLeadership();
          } else if (message.instanceId > this.instanceId && !this.isLeader) {
            this.becomeLeader();
          }
        }
        break;
      }
      case 'instance-stop': {
        // Another tab stopped. If it was the leader, we should consider becoming leader.
        if (!this.isLeader && this.isStarted && this.interval !== null) {
          this.becomeLeader();
        }
        break;
      }
      default:
        break;
    }
  }

  private runLeaderElection(): void {
    // Simple election: instance with smallest ID becomes leader
    // This is called synchronously during start, so we just announce ourselves
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'election-announce',
        instanceId: this.instanceId,
      });
    }
  }

  private becomeLeader(): void {
    const wasLeader = this.isLeader;
    this.isLeader = true;

    if (!wasLeader && this.isStarted && this.interval !== null) {
      // We just became the leader and the scheduler is running
      this.log('info', 'Became cross-tab leader, starting interval timer');
      this.startIntervalTimer();
    }
  }

  private cedeLeadership(): void {
    const wasLeader = this.isLeader;
    this.isLeader = false;

    if (wasLeader && this.intervalTimerId !== null) {
      // We just lost leadership
      this.log('info', 'Lost cross-tab leadership, stopping interval timer');
      clearInterval(this.intervalTimerId);
      this.intervalTimerId = null;
    }
  }

  private startIntervalTimer(): void {
    if (this.intervalTimerId !== null) {
      // Already running
      return;
    }

    if (!this.isLeader || this.interval === null) {
      // Only leader runs the timer
      return;
    }

    this.intervalTimerId = setInterval(() => {
      // Sync all projects on interval
      this.syncNow().catch((err) => {
        this.log('error', 'Error during interval sync', err);
      });
    }, this.interval);

    this.log('debug', `Started interval timer (${this.interval}ms)`);
  }

  private handleVisibilityChange(): void {
    const isHidden = document.hidden ?? false;

    if (this.wasHiddenLastCheck && !isHidden) {
      // Tab became visible
      this.log('debug', 'Tab became visible, triggering sync');
      this.syncNow().catch((err) => {
        this.log('error', 'Error during visibility-regain sync', err);
      });
    }

    this.wasHiddenLastCheck = isHidden;
  }

  private async performSync(projectId?: string): Promise<void> {
    if (!this.syncFn) {
      throw new Error('Sync function not set');
    }

    try {
      await this.syncFn(projectId);
    } catch (err) {
      this.log('error', `Sync failed for project ${projectId ?? 'all'}`, err);
      throw err;
    }
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: unknown
  ): void {
    if (this.logger) {
      this.logger.log(level, message, context);
    }
  }
}
