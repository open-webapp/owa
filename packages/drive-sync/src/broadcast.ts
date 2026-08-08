export interface BroadcastMessage {
  type: 'logout' | 'token';
  projectId: string;
}

export interface Broadcast {
  postLogout(projectId: string): void;
  postToken(projectId: string): void;
  onMessage(handler: (msg: BroadcastMessage) => void): () => void;
}

/**
 * Creates a cross-tab broadcast channel scoped to a single appId. Feature
 * detects BroadcastChannel and no-ops gracefully in environments where it is
 * unavailable (e.g. some server-side or older browser contexts).
 */
export function createBroadcast(appId: string): Broadcast {
  if (typeof BroadcastChannel === 'undefined') {
    return {
      postLogout(): void {},
      postToken(): void {},
      onMessage(): () => void {
        return () => {};
      },
    };
  }

  const channel = new BroadcastChannel(`owa-drive-${appId}`);

  function post(type: BroadcastMessage['type'], projectId: string): void {
    const msg: BroadcastMessage = { type, projectId };
    channel.postMessage(msg);
  }

  return {
    postLogout(projectId: string): void {
      post('logout', projectId);
    },
    postToken(projectId: string): void {
      post('token', projectId);
    },
    onMessage(handler: (msg: BroadcastMessage) => void): () => void {
      const listener = (event: MessageEvent): void => {
        handler(event.data as BroadcastMessage);
      };
      channel.addEventListener('message', listener);
      return () => {
        channel.removeEventListener('message', listener);
      };
    },
  };
}
