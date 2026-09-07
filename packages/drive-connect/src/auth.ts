import type { Connection, DriveAuthHandle, DriveAuthOptions, DriveAuthStatus } from './types.js';
import { createStatusStore, DISCONNECTED_STATUS } from './statusStore.js';

/** Interactive-call timeout, ported from portfolio's `handleConnect` Promise.race. */
const INTERACTIVE_TIMEOUT_MS = 10_000;

/**
 * A cached access token is "usable" only when a connection exists, it does
 * not need re-auth, and the token's expiry is far enough in the future.
 * Anything else means a Google auth flow is required before Drive I/O can run.
 *
 * Ported verbatim from portfolio's `src/lib/drive.ts` (`isTokenUsable`), with
 * the fixed `TOKEN_REAUTH_BUFFER_MS` constant lifted to the `bufferMs` param.
 */
function isTokenUsable(conn: Connection | null, bufferMs: number): conn is Connection {
  return (
    conn !== null &&
    !conn.needsReauth &&
    conn.expiresAt !== null &&
    conn.expiresAt > Date.now() + bufferMs
  );
}

/** Message string of any thrown value, matching portfolio's error-surface convention. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the non-interactive auth controller for one project.
 *
 * `refresh()` never opens a Google window and never runs through
 * `beforeInteractive`. `connect()` / `disconnect()` run the single interactive
 * drive-sync call through `beforeInteractive` (the `wrap`), guard against a
 * second concurrent connect via `connectInFlight`, and race the interactive
 * call against a 10s timeout. `ensureFresh()` returns the cached `Connection`
 * with zero interactive calls when the token still has runway, and otherwise
 * falls through to the shared `connect()` flow (same `connectInFlight` guard
 * and 10s timeout). `activate()` is a host-called passthrough to drive-sync's
 * background-refresh lifecycle.
 */
export function createDriveAuth({
  drive,
  projectId,
  tokenBufferMs = 5 * 60 * 1000,
  beforeInteractive,
}: DriveAuthOptions): DriveAuthHandle {
  const store = createStatusStore(DISCONNECTED_STATUS);

  // Never cache the project handle; resolve it per use.
  const project = () => drive.project(projectId);

  // ONE per handle instance. Shared by the widget's Connect button and (T6)
  // `ensureFresh()`, so back-to-back interactive requests fold into one flow
  // and one Google window.
  let connectInFlight: Promise<Connection> | null = null;

  // Wraps the single interactive drive-sync call (host uses this for e.g. a
  // service-worker reload suppression). Invoked exactly once per `connect()`
  // and once per `disconnect()`; NEVER for `refresh()` or (T6) the cached-token
  // fast path of `ensureFresh()`.
  const wrap = beforeInteractive ?? (<T,>(fn: () => Promise<T>) => fn());

  function getStatus(): DriveAuthStatus {
    return store.get();
  }

  function subscribe(listener: () => void): () => void {
    return store.subscribe(listener);
  }

  async function refresh(): Promise<DriveAuthStatus> {
    const conn = await project().getConnection();
    const current = store.get();
    const snapshot: DriveAuthStatus = {
      connected: conn !== null,
      email: conn?.email ?? null,
      expiresAt: conn?.expiresAt ?? null,
      needsReauth: conn?.needsReauth ?? false,
      tokenValid: isTokenUsable(conn, tokenBufferMs),
      connecting: current.connecting,
      error: current.error,
    };
    store.set(snapshot);
    return snapshot;
  }

  /**
   * The body of a connect flow. Races the interactive `project().connect()`
   * (through `wrap`) against a 10s timeout, normalises the result, and folds
   * the outcome into the status store. Any thrown value — timeout, GIS/consent
   * rejection, a drive-sync error surviving its own popup-closed recovery —
   * propagates UNCHANGED (same instance) after the store is reset to
   * disconnected+error.
   */
  async function runConnect(): Promise<Connection> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Google auth timed out')), INTERACTIVE_TIMEOUT_MS);
    });
    try {
      const connection = await Promise.race([wrap(() => project().connect()), timeout]);
      if (!connection) {
        throw new Error('No connection returned from Google Drive');
      }
      await refresh();
      store.patch({ connecting: false, error: null });
      return connection;
    } catch (err) {
      store.set({ ...DISCONNECTED_STATUS, error: messageOf(err) });
      throw err;
    } finally {
      // Clear the timer whether the interactive call resolved or rejected, so
      // a settled connect leaves no dangling timer / unhandled rejection.
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  function connect(): Promise<Connection> {
    if (connectInFlight) {
      return connectInFlight;
    }
    store.patch({ connecting: true, error: null });
    connectInFlight = runConnect().finally(() => {
      connectInFlight = null;
    });
    return connectInFlight;
  }

  async function disconnect(): Promise<void> {
    // Never routed through `connectInFlight`.
    store.patch({ connecting: true, error: null });
    try {
      await wrap(() => project().disconnect());
    } catch (err) {
      // Only `connecting` / `error` change — the connected status is left
      // intact so a failed disconnect doesn't visually drop the account.
      store.patch({ connecting: false, error: messageOf(err) });
      throw err;
    }
    store.set({ ...DISCONNECTED_STATUS });
  }

  return {
    getStatus,
    subscribe,
    refresh,
    connect,
    disconnect,
    // Non-interactive fast path: if the cached token still has enough runway
    // (strict `>` past `Date.now() + tokenBufferMs`, not needing re-auth, real
    // expiry), hand back the cached `Connection` with zero interactive calls,
    // no `wrap`/`beforeInteractive`, and no store write. Otherwise fall through
    // to the SAME `connect()` built above — reusing its `connectInFlight`
    // guard and 10s timeout, so a concurrent widget Connect folds into one flow.
    ensureFresh: async (): Promise<Connection> => {
      const conn = await project().getConnection();
      if (isTokenUsable(conn, tokenBufferMs)) {
        return conn;
      }
      return connect();
    },
    // Host-called only. drive-sync exposes `activate()` on the top-level
    // facade (per-project registration is implicit), so this forwards to
    // `drive.activate()` and returns its teardown fn unchanged.
    activate: () => drive.activate(),
  };
}
