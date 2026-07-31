/**
 * Main-side single Update status owner (issue #48).
 *
 * Owns: current snapshot, subscribers, library event wiring, launch/manual
 * check, quit-and-install. Built on the pure transition core (#44).
 *
 * No Electron / electron-updater imports — adapters are injected so unit tests
 * run under plain node without packaging or network.
 */

import type { UpdateStatus } from './types';
import {
  INITIAL_UPDATE_STATUS,
  reduceUpdateStatus,
  type UpdateEvent,
} from './update-status';

export type UpdateStatusListener = (status: UpdateStatus) => void;

/** Minimal surface of electron-updater's autoUpdater used by this owner. */
export type AutoUpdaterAdapter = {
  logger?: unknown;
  autoDownload: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
};

export type UpdateStatusOwnerLog = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type UpdateStatusOwnerDeps = {
  isPackaged: boolean;
  /**
   * Real autoUpdater in production. Optional in non-packaged / tests —
   * start() is a no-op without it when not packaged.
   */
  autoUpdater?: AutoUpdaterAdapter;
  log?: UpdateStatusOwnerLog;
  /**
   * Message used when check() runs outside a packaged build.
   * Dispatched into the live snapshot so GET_UPDATE_STATUS hydrates the same state.
   */
  nonPackagedMessage?: string;
};

export type UpdateStatusOwner = {
  getSnapshot(): UpdateStatus;
  /** Subscribe; immediately hydrates with the current snapshot. Returns unsubscribe. */
  subscribe(listener: UpdateStatusListener): () => void;
  /** Wire library listeners once (idempotent). Packaged builds only. */
  start(): void;
  /** Launch-time and manual check share this method. */
  check(): Promise<UpdateStatus>;
  quitAndInstall(): void;
  /** Test / internal seam: apply one pure event and notify subscribers. */
  dispatch(event: UpdateEvent): UpdateStatus;
};

const DEFAULT_NON_PACKAGED_MESSAGE =
  'Updates only available in the installed build';

const noopLog: UpdateStatusOwnerLog = {
  info: () => {},
  error: () => {},
};

/**
 * Create the single Update status owner for the main process.
 *
 * Callers wire tray + renderer as subscribers. Main bootstrap must not call
 * the updater library on a parallel path.
 */
export function createUpdateStatusOwner(
  deps: UpdateStatusOwnerDeps
): UpdateStatusOwner {
  const log = deps.log ?? noopLog;
  const nonPackagedMessage =
    deps.nonPackagedMessage ?? DEFAULT_NON_PACKAGED_MESSAGE;

  let current: UpdateStatus = INITIAL_UPDATE_STATUS;
  const listeners = new Set<UpdateStatusListener>();
  let started = false;

  function notify(status: UpdateStatus): void {
    for (const listener of listeners) {
      try {
        listener(status);
      } catch (err) {
        log.error('[updater] subscriber threw:', err);
      }
    }
  }

  function dispatch(event: UpdateEvent): UpdateStatus {
    const next = reduceUpdateStatus(current, event);
    // Identity-equal means the pure core kept the prior snapshot (e.g. late
    // progress after downloaded). Skip fan-out so subscribers see one notify
    // per real transition.
    if (next === current) {
      return current;
    }
    current = next;
    notify(current);
    return current;
  }

  function getSnapshot(): UpdateStatus {
    return current;
  }

  function subscribe(listener: UpdateStatusListener): () => void {
    listeners.add(listener);
    // Late subscribers hydrate from the live snapshot (banner/settings remount).
    try {
      listener(current);
    } catch (err) {
      log.error('[updater] hydrate subscriber threw:', err);
    }
    return () => {
      listeners.delete(listener);
    };
  }

  function start(): void {
    if (started) return;
    started = true;

    if (!deps.isPackaged) {
      // Dev / unpackaged: no library wiring. check() still yields not-available.
      return;
    }

    const au = deps.autoUpdater;
    if (!au) {
      log.error('[updater] start() packaged but no autoUpdater adapter');
      return;
    }

    // autoDownload is product policy (in-app restart-to-install). Logger is
    // set by the Electron glue (electron-log) before start when desired.
    au.autoDownload = true;

    au.on('checking-for-update', () => {
      dispatch({ type: 'check-started' });
    });

    au.on('update-available', (info: unknown) => {
      const version =
        info && typeof info === 'object' && 'version' in info
          ? String((info as { version?: unknown }).version ?? '')
          : undefined;
      dispatch({
        type: 'available',
        ...(version ? { version } : {}),
      });
    });

    au.on('update-not-available', () => {
      dispatch({ type: 'not-available' });
    });

    au.on('download-progress', (progress: unknown) => {
      const percent =
        progress && typeof progress === 'object' && 'percent' in progress
          ? Number((progress as { percent?: unknown }).percent)
          : undefined;
      dispatch({
        type: 'download-progress',
        ...(percent !== undefined && Number.isFinite(percent)
          ? { percent }
          : {}),
      });
    });

    au.on('update-downloaded', (info: unknown) => {
      const version =
        info && typeof info === 'object' && 'version' in info
          ? String((info as { version?: unknown }).version ?? '')
          : undefined;
      dispatch({
        type: 'downloaded',
        ...(version ? { version } : {}),
      });
    });

    au.on('error', (err: unknown) => {
      let message = 'Unknown update error';
      if (err != null && typeof err === 'object' && 'message' in err) {
        message = String(
          (err as { message?: unknown }).message ?? err
        );
      } else if (err != null) {
        message = String(err);
      }
      dispatch({ type: 'error', message });
    });
  }

  async function check(): Promise<UpdateStatus> {
    if (!deps.isPackaged) {
      // Real live snapshot so GET_UPDATE_STATUS / late hydrate match check().
      return dispatch({
        type: 'not-available',
        message: nonPackagedMessage,
      });
    }

    const au = deps.autoUpdater;
    if (!au) {
      return dispatch({
        type: 'error',
        message: 'Update checker not configured',
      });
    }

    try {
      await au.checkForUpdates();
    } catch (err) {
      log.error('[updater] checkForUpdates failed:', err);
    }
    return current;
  }

  function quitAndInstall(): void {
    log.info(
      '[updater] quitAndInstall requested (status=%s)',
      current.status
    );
    if (!deps.isPackaged || !deps.autoUpdater) {
      return;
    }
    deps.autoUpdater.quitAndInstall();
  }

  return {
    getSnapshot,
    subscribe,
    start,
    check,
    quitAndInstall,
    dispatch,
  };
}
