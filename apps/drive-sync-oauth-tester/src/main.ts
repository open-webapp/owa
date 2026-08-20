import { createDriveSync, PickerCancelledError, type Connection } from '@open-webapp/drive-sync';

const logger = {
  debug(...args: unknown[]): void {
    console.debug('[drive-sync]', ...args);
  },
  info(...args: unknown[]): void {
    console.info('[drive-sync]', ...args);
  },
  warn(...args: unknown[]): void {
    console.warn('[drive-sync]', ...args);
  },
  error(...args: unknown[]): void {
    console.error(...args);
  },
};

const APP_ID = 'drive-sync-oauth-tester';
const FOLDER_PATH = ['OAuthTester'];
const PROJECT_ID = 'oauth-tester';

const drive = createDriveSync({
  appId: APP_ID,
  clientId: import.meta.env.VITE_DRIVE_CLIENT_ID,
  folderPath: FOLDER_PATH,
  logger,
});

function renderStatus(conn: Connection | null): void {
  const stateEl = document.getElementById('state');
  const emailEl = document.getElementById('email');
  const expiresEl = document.getElementById('expires');

  if (stateEl) {
    stateEl.textContent = conn !== null ? 'connected' : 'disconnected';
  }
  if (emailEl) {
    emailEl.textContent = conn ? conn.email : '-';
  }
  if (expiresEl) {
    expiresEl.textContent = conn && conn.expiresAt != null ? new Date(conn.expiresAt).toLocaleString() : '-';
  }
  if (pickBtn) {
    pickBtn.disabled = conn === null;
  }
}

const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const pickBtn = document.getElementById('pick-btn') as HTMLButtonElement | null;
const pickedFilesEl = document.getElementById('picked-files');

connectBtn?.addEventListener('click', () => {
  void (async () => {
    try {
      const result = await p.connect();
      renderStatus(result);
    } catch (e) {
      logger.error('connect failed', e);
    }
  })();
});

disconnectBtn?.addEventListener('click', () => {
  void (async () => {
    try {
      await p.disconnect();
      renderStatus(null);
      if (pickedFilesEl) {
        pickedFilesEl.innerHTML = '';
      }
    } catch (e) {
      logger.error('disconnect failed', e);
    }
  })();
});

pickBtn?.addEventListener('click', () => {
  void (async () => {
    try {
      const results = await p.pickFile({
        apiKey: import.meta.env.VITE_DRIVE_PICKER_API_KEY,
        appId: import.meta.env.VITE_DRIVE_PICKER_APP_ID,
        multiSelect: true,
      });
      if (pickedFilesEl) {
        pickedFilesEl.innerHTML = '';
        for (const file of results) {
          const li = document.createElement('li');
          li.textContent = `${file.fileId} - ${file.name} (${file.mimeType})`;
          pickedFilesEl.appendChild(li);
        }
      }
    } catch (e) {
      if (e instanceof PickerCancelledError) {
        logger.info('picker cancelled', e);
      } else {
        logger.error('pick failed', e);
      }
    }
  })();
});

const _dispose = drive.activate();
await drive.reconcile([PROJECT_ID]);
const p = drive.project(PROJECT_ID);

const conn = await p.getConnection();
renderStatus(conn);
