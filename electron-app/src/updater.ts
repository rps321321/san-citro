import { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { IPC_CHANNELS, UpdateStatus } from './types';

// Latest known update state, kept here so CHECK_FOR_UPDATES can return it
// synchronously and the tray can reflect availability.
let currentStatus: UpdateStatus = { status: 'idle' };

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

function pushStatus(
  getMainWindow: () => BrowserWindow | null,
  status: UpdateStatus
): void {
  currentStatus = status;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.UPDATE_STATUS, status);
  }
}

/**
 * Wire electron-updater events and forward each as an UpdateStatus to the
 * renderer. Only meaningful in a packaged build; callers guard on
 * app.isPackaged. `onDownloaded` lets main.ts surface the update via tray.
 */
export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  onDownloaded: (status: UpdateStatus) => void
): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;

  autoUpdater.on('checking-for-update', () => {
    pushStatus(getMainWindow, { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    pushStatus(getMainWindow, { status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    pushStatus(getMainWindow, { status: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    pushStatus(getMainWindow, {
      status: 'downloading',
      percent: progress.percent,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const status: UpdateStatus = { status: 'downloaded', version: info.version };
    pushStatus(getMainWindow, status);
    onDownloaded(status);
  });

  autoUpdater.on('error', (err) => {
    pushStatus(getMainWindow, {
      status: 'error',
      message: err == null ? 'Unknown update error' : String(err.message ?? err),
    });
  });
}

/**
 * Trigger a check and return the current state. When not packaged, updates are
 * unavailable; we report that without touching autoUpdater (which throws in dev).
 */
export async function checkForUpdates(
  isPackaged: boolean
): Promise<UpdateStatus> {
  if (!isPackaged) {
    return {
      status: 'not-available',
      message: 'Updates only available in the installed build',
    };
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    log.error('[updater] checkForUpdates failed:', err);
  }
  return currentStatus;
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
