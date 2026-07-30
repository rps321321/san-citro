"use client";

/**
 * Shell-level Active downloads provider: one store instance, one getDownloads
 * hydrate, one onDownloadProgress subscription for the session.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  createActiveDownloadsStore,
  isLiveActiveStatus,
  type ActiveDownloadsSnapshot,
  type ActiveDownloadsStore,
  type ConnectionState,
} from "@/lib/active-downloads";
import type { DownloadStatus } from "@/types";

interface ActiveDownloadsContextValue {
  store: ActiveDownloadsStore;
}

const ActiveDownloadsContext = createContext<ActiveDownloadsContextValue | null>(
  null
);

function useStore(): ActiveDownloadsStore {
  const ctx = useContext(ActiveDownloadsContext);
  if (!ctx) {
    throw new Error("useActiveDownloads must be used within ActiveDownloadsProvider");
  }
  return ctx.store;
}

/** Mount once in the SPA shell. Owns the sole IPC hydrate + progress subscription. */
export function ActiveDownloadsProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ActiveDownloadsStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createActiveDownloadsStore();
  }
  const store = storeRef.current;

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    async function init() {
      if (typeof window === "undefined" || !window.sanCitro) {
        console.error(
          "[ActiveDownloads] window.sanCitro is not defined — preload script may have failed"
        );
        if (!cancelled) store.setConnection("disconnected");
        return;
      }

      try {
        const initial = await window.sanCitro.getDownloads();
        if (cancelled) return;
        if (initial.length > 0) {
          store.hydrate(initial);
        }

        const unsub = window.sanCitro.onDownloadProgress?.((data) => {
          store.applyProgress(data);
        });
        if (cancelled) {
          unsub?.();
          return;
        }
        if (unsub) unsubscribe = unsub;
        store.setConnection("connected");
      } catch (err) {
        console.error(
          "[ActiveDownloads] Failed to initialise IPC subscription:",
          err
        );
        if (!cancelled) store.setConnection("disconnected");
      }
    }

    void init();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [store]);

  const value = useMemo(() => ({ store }), [store]);

  return (
    <ActiveDownloadsContext.Provider value={value}>
      {children}
    </ActiveDownloadsContext.Provider>
  );
}

function useSnapshot(): ActiveDownloadsSnapshot {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}

/**
 * Full live Map + connection + session completed set + remove helper.
 * Status Island, Downloads/Activity, and Search share this view.
 */
export function useActiveDownloads(): {
  downloads: ReadonlyMap<string, DownloadStatus>;
  connection: ConnectionState;
  completedThisSession: ReadonlySet<string>;
  removeDownloads: (md5s: string[]) => void;
  /** Feed startDownload return into the same store (no second IPC listener). */
  applyProgress: (data: DownloadStatus | DownloadStatus[]) => void;
} {
  const store = useStore();
  const snap = useSnapshot();

  const removeDownloads = useCallback(
    (md5s: string[]) => {
      store.removeDownloads(md5s);
    },
    [store]
  );

  const applyProgress = useCallback(
    (data: DownloadStatus | DownloadStatus[]) => {
      store.applyProgress(data);
    },
    [store]
  );

  return {
    downloads: snap.downloads,
    connection: snap.connection,
    completedThisSession: snap.completedThisSession,
    removeDownloads,
    applyProgress,
  };
}

/** Selector: live status for one md5, if still in the live list. */
export function useDownloadByMd5(md5: string | undefined): DownloadStatus | undefined {
  const { downloads } = useActiveDownloads();
  if (!md5) return undefined;
  return downloads.get(md5);
}

/** Count of non-terminal live transfers (island badge). */
export function useActiveDownloadCount(): number {
  const { downloads } = useActiveDownloads();
  let n = 0;
  for (const d of downloads.values()) {
    if (isLiveActiveStatus(d.status)) n += 1;
  }
  return n;
}

export type { ConnectionState };
