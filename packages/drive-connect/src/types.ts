import type { DriveSync, Connection } from '@open-webapp/drive-sync';
import type { ReactNode } from 'react';

export interface DriveAuthOptions {
  drive: DriveSync;
  projectId: string;
  tokenBufferMs?: number;                       // default 5*60*1000
  beforeInteractive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface DriveAuthStatus {
  connected: boolean;
  email: string | null;
  expiresAt: number | null;
  needsReauth: boolean;
  tokenValid: boolean;
  connecting: boolean;
  error: string | null;
}

export interface DriveAuthHandle {
  getStatus(): DriveAuthStatus;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<DriveAuthStatus>;
  connect(): Promise<Connection>;
  disconnect(): Promise<void>;
  ensureFresh(): Promise<Connection>;
  activate(): () => void;
}

export interface DriveWidgetClassNames {
  root?: string; status?: string; email?: string; connectButton?: string;
  disconnectButton?: string; reauth?: string; error?: string; description?: string;
}

export interface GoogleDriveWidgetProps {
  auth: DriveAuthHandle;
  onConnected?: (connection: Connection) => void;
  onDisconnected?: () => void;
  classNames?: DriveWidgetClassNames;
  description?: ReactNode;
}

export type { Connection };
