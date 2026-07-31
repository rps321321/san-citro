import { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { IPC_CHANNELS, UpdateStatus } from './types';
import {
  INITIAL_UPDATE_STATUS,
  reduceUpdateStatus,
  type UpdateEvent,
} from './update-status';

// Re-export pure core so callers/tests can import from one place if needed.
export {
  INITIAL_UPDATE_STATUS,
  reduceUpdateStatus,
  type UpdateEvent,
} from './update-status';

// Latest known update state, kept here so CHECK_FOR_UPDATES can return it
// synchronously and the tray can reflect availability. Transitions go through
// reduceUpdateStatus only — listeners never hand-build status objects.
let currentStatus: UpdateStatus = INITIAL_UPDATE_STATUS;

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

function applyEvent(
  getMainWindow: () => BrowserWindow | null,
  onStatus: (status: UpdateStatus) => void,
  event: UpdateEvent
): void {
  const next = reduceUpdateStatus(currentStatus, event);
  pushStatus(getMainWindow, next);
  onStatus(next);
}

/**
 * Wire electron-updater events and forward each as an UpdateStatus to the
 * renderer. Only meaningful in a packaged build; callers guard on
 * app.isPackaged. `onStatus` mirrors every status (tray + any main-side UI).
 *
 * Listeners translate library events into pure UpdateEvents; status shape is
 * owned by reduceUpdateStatus (see update-status.ts).
 */
export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  onStatus: (status: UpdateStatus) => void
): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;

  const apply = (event: UpdateEvent) =>
    applyEvent(getMainWindow, onStatus, event);

  autoUpdater.on('checking-for-update', () => {
    apply({ type: 'check-started' });
  });

  autoUpdater.on('update-available', (info) => {
    apply({ type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    apply({ type: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    apply({
      type: 'download-progress',
      percent: progress.percent,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    apply({ type: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    apply({
      type: 'error',
      message:
        err == null ? 'Unknown update error' : String(err.message ?? err),
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
    // Pure construction of the not-available snapshot; do not mutate the
    // live currentStatus (dev stays idle until a real packaged session).
    return reduceUpdateStatus(INITIAL_UPDATE_STATUS, {
      type: 'not-available',
      message: 'Updates only available in the installed build',
    });
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
