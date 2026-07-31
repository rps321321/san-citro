/**
 * Pure Update status transition core.
 *
 * electron-updater events are translated into UpdateEvent values by the
 * Electron wiring layer (updater.ts); this module never imports Electron or
 * electron-updater so sequences can be unit-tested without packaging/network.
 *
 * Status vocabulary (matches types.UpdateStatus):
 *   idle | checking | available | downloading | downloaded | not-available | error
 */

import type { UpdateStatus } from './types';

export type { UpdateStatus };

export const INITIAL_UPDATE_STATUS: UpdateStatus = { status: 'idle' };

export type UpdateEvent =
  | { type: 'check-started' }
  | { type: 'available'; version?: string }
  | { type: 'download-progress'; percent?: number; version?: string }
  | { type: 'downloaded'; version?: string }
  | { type: 'not-available'; message?: string }
  | { type: 'error'; message: string }
  | { type: 'reset' };

/** Clamp a progress value into [0, 100]. Non-finite / missing → undefined. */
export function clampPercent(percent: number | undefined): number | undefined {
  if (percent == null || !Number.isFinite(percent)) return undefined;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}

/**
 * Reduce the current Update status snapshot by one pure event.
 *
 * Rules:
 * - check-started → checking (from any state; supports check-again / retry)
 * - available → available with optional version
 * - download-progress → downloading with clamped percent; retains known version
 *   when the event omits it. Late progress must not downgrade `downloaded`.
 * - downloaded → downloaded with optional version (falls back to known)
 * - not-available / error → terminal-ish snapshots with optional/required message
 * - reset → idle
 */
export function reduceUpdateStatus(
  current: UpdateStatus,
  event: UpdateEvent
): UpdateStatus {
  switch (event.type) {
    case 'reset':
      return { status: 'idle' };

    case 'check-started':
      // A new check is allowed from any non-installing state, including after
      // error / not-available / downloaded, so Settings "Check again" works.
      return { status: 'checking' };

    case 'available': {
      const next: UpdateStatus = { status: 'available' };
      if (event.version != null && event.version !== '') {
        next.version = event.version;
      } else if (current.version) {
        next.version = current.version;
      }
      return next;
    }

    case 'download-progress': {
      // Stale progress after the installer is fully downloaded must not
      // regress the UI back to a non-Restartable "downloading" state.
      if (current.status === 'downloaded') {
        return current;
      }
      const next: UpdateStatus = { status: 'downloading' };
      const percent = clampPercent(event.percent);
      if (percent !== undefined) {
        next.percent = percent;
      }
      const version =
        event.version != null && event.version !== ''
          ? event.version
          : current.version;
      if (version) {
        next.version = version;
      }
      return next;
    }

    case 'downloaded': {
      const next: UpdateStatus = { status: 'downloaded' };
      const version =
        event.version != null && event.version !== ''
          ? event.version
          : current.version;
      if (version) {
        next.version = version;
      }
      return next;
    }

    case 'not-available': {
      const next: UpdateStatus = { status: 'not-available' };
      if (event.message != null && event.message !== '') {
        next.message = event.message;
      }
      return next;
    }

    case 'error': {
      const message =
        event.message != null && String(event.message).trim() !== ''
          ? String(event.message)
          : 'Unknown update error';
      return { status: 'error', message };
    }

    default: {
      // Exhaustiveness: unknown events leave status unchanged.
      const _exhaustive: never = event;
      void _exhaustive;
      return current;
    }
  }
}
