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
 * app.isPackaged. `onStatus` mirrors every status (tray + any main-side UI).
 */
export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  onStatus: (status: UpdateStatus) => void
): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;

  const emit = (status: UpdateStatus) => {
    pushStatus(getMainWindow, status);
    onStatus(status);
  };

  autoUpdater.on('checking-for-update', () => {
    emit({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    emit({ status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    emit({ status: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    emit({
      status: 'downloading',
      percent: progress.percent,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    emit({ status: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    emit({
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
  log.info('[updater] quitAndInstall requested (status=%s)', currentStatus.status);
  autoUpdater.quitAndInstall();
}
