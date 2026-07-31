/**
 * Electron glue for the main-side Update status owner.
 *
 * The owner itself lives in update-status-owner.ts (injectable, unit-tested).
 * This module holds the process singleton, binds electron-updater + log, and
 * exposes the IPC-facing helpers used by ipc-handlers / main.
 *
 * Preserve: GitHub provider (electron-builder publish), autoDownload, artifact
 * naming / installer policy (ADR-0015) — none of those are touched here.
 */

import { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { IPC_CHANNELS, type UpdateStatus } from './types';
import {
  createUpdateStatusOwner,
  type UpdateStatusOwner,
  type UpdateStatusListener,
} from './update-status-owner';

// Re-export pure core + owner factory so callers/tests can import from one place.
export {
  INITIAL_UPDATE_STATUS,
  reduceUpdateStatus,
  type UpdateEvent,
} from './update-status';
export {
  createUpdateStatusOwner,
  type UpdateStatusOwner,
  type UpdateStatusListener,
  type AutoUpdaterAdapter,
} from './update-status-owner';

let owner: UpdateStatusOwner | null = null;
let rendererUnsub: (() => void) | null = null;

function requireOwner(): UpdateStatusOwner {
  if (!owner) {
    throw new Error(
      '[updater] Update status owner not started — call startUpdateStatusOwner() first'
    );
  }
  return owner;
}

/**
 * Create and install the process-wide Update status owner.
 * Safe to call once at app ready. Idempotent if already started.
 */
export function startUpdateStatusOwner(opts: {
  isPackaged: boolean;
  getMainWindow: () => BrowserWindow | null;
}): UpdateStatusOwner {
  if (owner) {
    return owner;
  }

  // Preserve electron-log as the library logger backend (owner does not replace it).
  autoUpdater.logger = log;

  owner = createUpdateStatusOwner({
    isPackaged: opts.isPackaged,
    // electron-updater's EventEmitter typing is wider; adapter only needs on/check/quit.
    autoUpdater: autoUpdater as unknown as import('./update-status-owner').AutoUpdaterAdapter,
    log: {
      info: (...args: unknown[]) => log.info(...args),
      error: (...args: unknown[]) => log.error(...args),
    },
  });

  owner.start();

  // Renderer push is a subscriber of the single owner (not a parallel path).
  rendererUnsub = owner.subscribe((status) => {
    const win = opts.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UPDATE_STATUS, status);
    }
  });

  return owner;
}

/** Process-wide owner (after startUpdateStatusOwner). */
export function getUpdateStatusOwner(): UpdateStatusOwner {
  return requireOwner();
}

export function getUpdateStatus(): UpdateStatus {
  return requireOwner().getSnapshot();
}

/**
 * Trigger a check and return the current snapshot.
 * Non-packaged builds dispatch a live not-available state (owner owns that).
 * `isPackaged` is accepted for call-site compatibility but the owner was
 * configured at start — prefer owner.check() directly from new code.
 */
export async function checkForUpdates(
  _isPackaged?: boolean
): Promise<UpdateStatus> {
  return requireOwner().check();
}

export function quitAndInstall(): void {
  requireOwner().quitAndInstall();
}

/** Subscribe to status transitions (tray projection, tests). */
export function subscribeUpdateStatus(
  listener: UpdateStatusListener
): () => void {
  return requireOwner().subscribe(listener);
}

/** Test/teardown helper — clears the process singleton. */
export function _resetUpdateStatusOwnerForTests(): void {
  if (rendererUnsub) {
    rendererUnsub();
    rendererUnsub = null;
  }
  owner = null;
}
