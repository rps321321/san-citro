/**
 * Active downloads session store — single Map + single retention policy for the
 * live Download lifecycle UI view (CONTEXT: Active downloads).
 *
 * Pure module (no React): hydrate, apply progress, selector-by-md5, terminal
 * retention. The shell provider owns one instance and wires getDownloads +
 * onDownloadProgress once; Status Island, Downloads/Activity, and Search are
 * views over the same store.
 *
 * Terminal retention is backend-owned: live payloads carry `terminal_expires_at`
 * (unix seconds). The store schedules eviction from that deadline so Python prune
 * and the renderer share one clock. A local fallback delay is used only when an
 * older bridge omits the field.
 */

import type { DownloadStatus, LiveDownloadStatus } from "@/types";
import { normalizeDownloadStatus } from "@/lib/status";

/**
 * Temporary fallback retention when a progress/hydration payload lacks
 * `terminal_expires_at` (pre-#45 bridge). Prefer the backend deadline field.
 * Not the primary policy — do not dual-maintain against TERMINAL_RETENTION_S.
 */
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
  const s = normalizeDownloadStatus(status);
  return s === "queued" || s === "downloading";
}

/** Coerce inbound IPC payloads onto public live statuses. */
export function normalizeLiveDownload(item: DownloadStatus): DownloadStatus {
  const status = normalizeDownloadStatus(item.status) as LiveDownloadStatus;
  if (status === item.status) return item;
  return { ...item, status };
}

/**
 * Delay until backend-owned `terminal_expires_at` (seconds), else temporary
 * full-window fallback. Exported for contract tests.
 */
export function evictionDelayMs(
  item: Pick<DownloadStatus, "terminal_expires_at">,
  nowMs: number,
  fallbackRetentionMs: number
): number {
  const expiresAt = item.terminal_expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return Math.max(0, expiresAt * 1000 - nowMs);
  }
  return fallbackRetentionMs;
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
  /**
   * Temporary fallback when payload lacks `terminal_expires_at`.
   * Primary path uses the backend deadline field.
   */
  retentionMs?: number;
  /** Injectable clock (ms since epoch) for tests. Defaults to Date.now. */
  now?: () => number;
}): ActiveDownloadsStore {
  const timers = options?.timers ?? defaultTimers;
  const retentionMs = options?.retentionMs ?? TERMINAL_RETENTION_MS;
  const nowFn = options?.now ?? (() => Date.now());

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

  function scheduleEviction(md5: string, item: DownloadStatus): void {
    clearEviction(md5);
    const delayMs = evictionDelayMs(item, nowFn(), retentionMs);
    const handle = timers.setTimeout(() => {
      evictionTimers.delete(md5);
      if (!downloads.has(md5)) return;
      const next = new Map(downloads);
      next.delete(md5);
      downloads = next;
      emit();
    }, delayMs);
    evictionTimers.set(md5, handle);
  }

  function applyItems(items: DownloadStatus[]): void {
    if (items.length === 0) return;
    const next = new Map(downloads);
    let completedChanged = false;
    let nextCompleted = completedThisSession;
    const normalizedItems: DownloadStatus[] = [];

    for (const raw of items) {
      const d = normalizeLiveDownload(raw);
      normalizedItems.push(d);
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

    for (const d of normalizedItems) {
      if (isTerminalStatus(d.status)) {
        scheduleEviction(d.md5, d);
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
