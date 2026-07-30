/**
 * Active downloads session store — single Map + single retention policy for the
 * live Download lifecycle UI view (CONTEXT: Active downloads).
 *
 * Pure module (no React): hydrate, apply progress, selector-by-md5, terminal
 * retention. The shell provider owns one instance and wires getDownloads +
 * onDownloadProgress once; Status Island, Downloads/Activity, and Search are
 * views over the same store.
 */

import type { DownloadStatus } from "@/types";

/** Auto-remove terminal entries from the live list after this window. */
export const TERMINAL_RETENTION_MS = 60_000;

/** Link health for the IPC progress subscription (not a download status). */
export type ConnectionState = "connecting" | "connected" | "disconnected";

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface ActiveDownloadsTimers {
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (id: TimerHandle) => void;
}

export interface ActiveDownloadsSnapshot {
  downloads: ReadonlyMap<string, DownloadStatus>;
  connection: ConnectionState;
  /** md5s that reached completed this session (survives live-list retention). */
  completedThisSession: ReadonlySet<string>;
}

export type ActiveDownloadsListener = (snapshot: ActiveDownloadsSnapshot) => void;

const defaultTimers: ActiveDownloadsTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isLiveActiveStatus(status: string): boolean {
  return status === "queued" || status === "downloading" || status === "started";
}

export interface ActiveDownloadsStore {
  subscribe(listener: ActiveDownloadsListener): () => void;
  getSnapshot(): ActiveDownloadsSnapshot;
  getByMd5(md5: string): DownloadStatus | undefined;
  setConnection(connection: ConnectionState): void;
  /** Replace/merge initial getDownloads() payload. */
  hydrate(items: DownloadStatus[]): void;
  /** Apply one or many progress/status events (same path as IPC). */
  applyProgress(data: DownloadStatus | DownloadStatus[]): void;
  /** Manual remove (e.g. Clear finished); cancels pending retention timers. */
  removeDownloads(md5s: string[]): void;
  /** Drop all state (tests). */
  reset(): void;
}

export function createActiveDownloadsStore(options?: {
  timers?: ActiveDownloadsTimers;
  retentionMs?: number;
}): ActiveDownloadsStore {
  const timers = options?.timers ?? defaultTimers;
  const retentionMs = options?.retentionMs ?? TERMINAL_RETENTION_MS;

  let downloads = new Map<string, DownloadStatus>();
  let connection: ConnectionState = "connecting";
  let completedThisSession = new Set<string>();
  const evictionTimers = new Map<string, TimerHandle>();
  const listeners = new Set<ActiveDownloadsListener>();
  // Cached snapshot object — useSyncExternalStore requires referential stability
  // between emissions (a new object every getSnapshot() would infinite-loop React).
  let cachedSnapshot: ActiveDownloadsSnapshot = {
    downloads,
    connection,
    completedThisSession,
  };

  function rebuildSnapshot(): ActiveDownloadsSnapshot {
    cachedSnapshot = {
      downloads,
      connection,
      completedThisSession,
    };
    return cachedSnapshot;
  }

  function emit(): void {
    const snap = rebuildSnapshot();
    for (const listener of listeners) {
      listener(snap);
    }
  }

  function clearEviction(md5: string): void {
    const existing = evictionTimers.get(md5);
    if (existing !== undefined) {
      timers.clearTimeout(existing);
      evictionTimers.delete(md5);
    }
  }

  function scheduleEviction(md5: string): void {
    clearEviction(md5);
    const handle = timers.setTimeout(() => {
      evictionTimers.delete(md5);
      if (!downloads.has(md5)) return;
      const next = new Map(downloads);
      next.delete(md5);
      downloads = next;
      emit();
    }, retentionMs);
    evictionTimers.set(md5, handle);
  }

  function applyItems(items: DownloadStatus[]): void {
    if (items.length === 0) return;
    const next = new Map(downloads);
    let completedChanged = false;
    let nextCompleted = completedThisSession;

    for (const d of items) {
      next.set(d.md5, d);
      if (d.status === "completed") {
        if (!nextCompleted.has(d.md5)) {
          if (nextCompleted === completedThisSession) {
            nextCompleted = new Set(completedThisSession);
          }
          nextCompleted.add(d.md5);
          completedChanged = true;
        }
      }
    }

    downloads = next;
    if (completedChanged) {
      completedThisSession = nextCompleted;
    }

    for (const d of items) {
      if (isTerminalStatus(d.status)) {
        scheduleEviction(d.md5);
      } else {
        // Non-terminal update cancels a prior retention timer (e.g. retry).
        clearEviction(d.md5);
      }
    }

    emit();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return cachedSnapshot;
    },

    getByMd5(md5) {
      return downloads.get(md5);
    },

    setConnection(next) {
      if (connection === next) return;
      connection = next;
      emit();
    },

    hydrate(items) {
      applyItems(items);
    },

    applyProgress(data) {
      const items = Array.isArray(data) ? data : [data];
      applyItems(items);
    },

    removeDownloads(md5s) {
      if (md5s.length === 0) return;
      const next = new Map(downloads);
      let changed = false;
      for (const md5 of md5s) {
        if (next.delete(md5)) changed = true;
        clearEviction(md5);
      }
      if (!changed) return;
      downloads = next;
      emit();
    },

    reset() {
      for (const handle of evictionTimers.values()) {
        timers.clearTimeout(handle);
      }
      evictionTimers.clear();
      downloads = new Map();
      connection = "connecting";
      completedThisSession = new Set();
      emit();
    },
  };
}

