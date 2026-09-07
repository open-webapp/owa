// Component tests for <GoogleDriveWidget /> (decision 15: four render states)
// plus the mount / visibilitychange / unmount lifecycle contract.
//
// Each test builds a fresh harness + a real `createDriveAuth` handle bound to
// it, renders the widget through `@testing-library/react`, and asserts against
// the REAL fake-backed drive-sync behavior (no mocked auth handle).
//
// T12 is the first of two tasks on this file; T13 appends more cases below the
// existing `describe` blocks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { createDriveAuth } from '../auth.js';
import type { Connection } from '../types.js';
import { GoogleDriveWidget } from '../GoogleDriveWidget.js';
import { makeHarness, type Harness } from './harness.js';

const FULL_SCOPE =
  'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

let harnesses: Harness[] = [];

/** Build a harness that is torn down automatically in afterEach. */
function newHarness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

afterEach(() => {
  cleanup();
  for (const h of harnesses) h.cleanup();
  harnesses = [];
  vi.restoreAllMocks();
});

describe('GoogleDriveWidget — four states (decision 15)', () => {
  it('state 1 — not connected: shows an enabled "Connect Google Drive" button, no email, no Disconnect', async () => {
    const h = newHarness();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    render(<GoogleDriveWidget auth={auth} />);

    // Mount refresh() resolves to "no connection"; the Connect button stays.
    const connectBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });
    expect(connectBtn).toBeEnabled();

    expect(screen.queryByText(/Connected as/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('state 2 — connecting: Connect button swaps to a disabled "Connecting…" button while the interactive call is pending', async () => {
    const h = newHarness();

    // Gate the single interactive drive-sync call so `connect()` stays pending
    // in a deterministic way (no reliance on the 10s race timer).
    let releaseInteractive!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseInteractive = resolve;
    });
    const auth = createDriveAuth({
      drive: h.drive,
      projectId: h.projectId,
      beforeInteractive: async (fn) => {
        await gate;
        return fn();
      },
    });

    render(<GoogleDriveWidget auth={auth} />);
    const connectBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });

    // connect() synchronously patches { connecting: true } before awaiting.
    fireEvent.click(connectBtn);

    const connectingBtn = await screen.findByRole('button', {
      name: 'Connecting…',
    });
    expect(connectingBtn).toBeDisabled();

    // Settle the pending flow: queue a real successful GIS token, open the
    // gate, and let drive-sync complete the connect → widget reaches Connected.
    h.gisFake.queueResponse({
      access_token: 'tok-connecting',
      expires_in: 3600,
      scope: FULL_SCOPE,
    });
    releaseInteractive();

    await screen.findByRole('button', { name: 'Disconnect' });
  });

  it('state 3 — connected: renders the account email and a real Disconnect <button>', async () => {
    const h = newHarness();
    await h.seedConnection({ email: 'me@example.com' });

    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });
    render(<GoogleDriveWidget auth={auth} />);

    // Mount refresh() picks up the seeded connection.
    await screen.findByText(/Connected as/);
    expect(screen.getByText('me@example.com')).toBeInTheDocument();

    // Must resolve to an actual <button> — fails if "Disconnect" were a <span>.
    const disconnectBtn = screen.getByRole('button', { name: 'Disconnect' });
    expect(disconnectBtn.tagName).toBe('BUTTON');

    expect(
      screen.queryByRole('button', { name: 'Connect Google Drive' }),
    ).toBeNull();
  });

  it('state 4 — connected + needsReauth: shows the reauth prompt + a "Reconnect" button, and NO "Connect Google Drive" button', async () => {
    const h = newHarness();
    await h.seedConnection({ email: 'me@example.com', needsReauth: true });

    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });
    render(<GoogleDriveWidget auth={auth} />);

    await screen.findByText('Reconnect to restore sync');
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();

    expect(
      screen.queryByRole('button', { name: 'Connect Google Drive' }),
    ).toBeNull();
    // The reauth branch renders exactly one button (Reconnect), not a second
    // Connect button.
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });
});

describe('GoogleDriveWidget — mount / visibility / unmount lifecycle', () => {
  it('mounts with exactly ONE auth.refresh() and ZERO auth.activate()', async () => {
    const h = newHarness();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    const refreshSpy = vi.spyOn(auth, 'refresh');
    const activateSpy = vi.spyOn(auth, 'activate');

    render(<GoogleDriveWidget auth={auth} />);

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it('a visibilitychange to "visible" triggers another auth.refresh()', async () => {
    const h = newHarness();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    const refreshSpy = vi.spyOn(auth, 'refresh');

    render(<GoogleDriveWidget auth={auth} />);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(2));
  });

  it('unmount removes the visibilitychange listener (no further auth.refresh())', async () => {
    const h = newHarness();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    const refreshSpy = vi.spyOn(auth, 'refresh');

    const { unmount } = render(<GoogleDriveWidget auth={auth} />);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));

    unmount();

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    fireEvent(document, new Event('visibilitychange'));

    // Give any stray async listener a chance to fire before asserting.
    await Promise.resolve();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T13 — flows, callbacks, errors. Appended below the T12 blocks; reuses the
// module-level `newHarness()` + `afterEach` (RTL cleanup + harness cleanup +
// `vi.restoreAllMocks()`), adds only a per-test `window.alert` spy.
// ---------------------------------------------------------------------------

describe('GoogleDriveWidget — connect / disconnect flows, callbacks, errors', () => {
  beforeEach(() => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  it('1. connect success — onConnected fires exactly once with the Connection, widget flips to connected', async () => {
    const h = newHarness();
    h.gisFake.queueResponse({
      access_token: 'tok-success',
      expires_in: 3600,
      scope: FULL_SCOPE,
    });
    const onConnected = vi.fn();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    render(<GoogleDriveWidget auth={auth} onConnected={onConnected} />);
    const connectBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });

    fireEvent.click(connectBtn);

    // Widget reaches the connected state.
    await screen.findByRole('button', { name: 'Disconnect' });
    await screen.findByText(/Connected as/);
    expect(screen.getByText('user@example.com')).toBeInTheDocument();

    expect(onConnected).toHaveBeenCalledTimes(1);
    const conn = onConnected.mock.calls[0][0] as Connection;
    expect(conn.email).toBe('user@example.com');

    expect(window.alert).not.toHaveBeenCalled();
  });

  it('2. connect failure — onConnected NOT called, role="alert" holds the error, widget back to an enabled Connect button', async () => {
    const h = newHarness();
    h.gisFake.queuePopupError('access_denied');
    const onConnected = vi.fn();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    render(<GoogleDriveWidget auth={auth} onConnected={onConnected} />);
    const connectBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });

    fireEvent.click(connectBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent?.trim()).toBeTruthy();

    expect(onConnected).not.toHaveBeenCalled();

    const backBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });
    expect(backBtn).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();

    expect(window.alert).not.toHaveBeenCalled();
  });

  it('3. connect timeout — the 10s interactive race surfaces "Google auth timed out" in a role="alert"', async () => {
    const h = newHarness();
    // A `beforeInteractive` wrap that never resolves keeps the interactive
    // call pending WITHOUT ever entering drive-sync (`project().connect()` is
    // not invoked), so nothing is left half-open across the test boundary —
    // the only thing that settles the flow is auth.ts's 10s race timer. GIS
    // silence (`queueSilence()`) would hang drive-sync's connect forever and
    // leak an open IndexedDB handle into later tests.
    const neverReleased = new Promise<void>(() => {});
    const auth = createDriveAuth({
      drive: h.drive,
      projectId: h.projectId,
      beforeInteractive: async (fn) => {
        await neverReleased;
        return fn();
      },
    });

    // Mount + first paint happen under real timers; the widget's "not
    // connected" state renders the Connect button synchronously.
    render(<GoogleDriveWidget auth={auth} />);
    const connectBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });

    // Fake ONLY setTimeout/clearTimeout/Date (T8's set) so fake-indexeddb's
    // microtask-driven work keeps running; drive off the 10s race timer, then
    // hand control back to real timers before asserting on the re-render.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      fireEvent.click(connectBtn);
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Google auth timed out');
    expect(
      await screen.findByRole('button', { name: 'Connect Google Drive' }),
    ).toBeEnabled();

    expect(window.alert).not.toHaveBeenCalled();
  });

  it('4. disconnect success — onDisconnected fires once, widget returns to the Connect state', async () => {
    const h = newHarness();
    await h.seedConnection({ email: 'me@example.com' });
    const onDisconnected = vi.fn();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    render(<GoogleDriveWidget auth={auth} onDisconnected={onDisconnected} />);
    const disconnectBtn = await screen.findByRole('button', {
      name: 'Disconnect',
    });

    fireEvent.click(disconnectBtn);

    await screen.findByRole('button', { name: 'Connect Google Drive' });
    expect(screen.queryByText(/Connected as/)).toBeNull();

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('5. disconnect failure — onDisconnected NOT called, role="alert" shows the message, widget stays connected', async () => {
    const h = newHarness();

    // Force `project().disconnect()` to reject at the drive-sync facade
    // boundary (no drive-sync internals stubbed); `connect()` is untouched so
    // `seedConnection()` still works.
    const realProject = h.drive.project.bind(h.drive);
    h.drive.project = ((id: string) => {
      const handle = realProject(id);
      return {
        ...handle,
        disconnect: () => Promise.reject(new Error('revoke failed')),
      };
    }) as typeof h.drive.project;

    await h.seedConnection({ email: 'me@example.com' });
    const onDisconnected = vi.fn();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    render(<GoogleDriveWidget auth={auth} onDisconnected={onDisconnected} />);
    const disconnectBtn = await screen.findByRole('button', {
      name: 'Disconnect',
    });

    fireEvent.click(disconnectBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('revoke failed');

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Disconnect' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Connect Google Drive' }),
    ).toBeNull();

    expect(window.alert).not.toHaveBeenCalled();
  });

  it('6. double-click Connect within one pending window — exactly ONE GIS call (shared in-flight guard, seen through the UI)', async () => {
    const h = newHarness();

    let releaseInteractive!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseInteractive = resolve;
    });
    const auth = createDriveAuth({
      drive: h.drive,
      projectId: h.projectId,
      beforeInteractive: async (fn) => {
        await gate;
        return fn();
      },
    });

    render(<GoogleDriveWidget auth={auth} />);
    const connectBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });

    // Both clicks land while the single interactive call is gated: the first
    // folds into `connectInFlight` and flips the button to a disabled
    // "Connecting…", the second is a no-op. No GIS call yet.
    fireEvent.click(connectBtn);
    fireEvent.click(connectBtn);
    await screen.findByRole('button', { name: 'Connecting…' });
    expect(h.gisFake.calls.length).toBe(0);

    // Settle: one real token, open the gate → exactly one GIS call total.
    h.gisFake.queueResponse({
      access_token: 'tok-double',
      expires_in: 3600,
      scope: FULL_SCOPE,
    });
    releaseInteractive();

    await screen.findByRole('button', { name: 'Disconnect' });
    expect(h.gisFake.calls.length).toBe(1);
  });

  it('7. classNames bag — host classes are merged alongside the package classes', async () => {
    const h = newHarness();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    const { container } = render(
      <GoogleDriveWidget
        auth={auth}
        classNames={{ root: 'x-root', connectButton: 'x-connect' }}
      />,
    );
    const connectBtn = await screen.findByRole('button', {
      name: 'Connect Google Drive',
    });

    const root = container.querySelector('.owa-drive-root');
    expect(root).not.toBeNull();
    expect(root).toHaveClass('x-root', 'owa-drive-root');
    expect(connectBtn).toHaveClass('x-connect', 'owa-drive-connect');
  });

  it('8. description prop — rendered when provided, absent (no wrapper node) when omitted', async () => {
    const h = newHarness();
    const auth = createDriveAuth({ drive: h.drive, projectId: h.projectId });

    const { container, rerender } = render(
      <GoogleDriveWidget
        auth={auth}
        description={<span data-testid="desc">hello</span>}
      />,
    );
    await screen.findByRole('button', { name: 'Connect Google Drive' });
    expect(screen.getByTestId('desc')).toBeInTheDocument();

    rerender(<GoogleDriveWidget auth={auth} />);
    expect(screen.queryByTestId('desc')).toBeNull();
    expect(container.querySelector('.owa-drive-description')).toBeNull();
  });
});
