"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadStatus } from "@/types";

const TERMINAL_RETENTION_MS = 60_000; // auto-remove completed/failed entries after 60s

/**
 * Subscribes to IPC download progress events for real-time download status.
 * Returns a Map keyed by md5, updated as events arrive.
 */
export function useDownloadStream() {
  const [downloads, setDownloads] = useState<Map<string, DownloadStatus>>(
    new Map()
  );
  const [isConnected, setIsConnected] = useState(false);
  const evictionTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    const isTerminal = (status: string) =>
      status === "completed" || status === "failed" || status === "cancelled";

    const scheduleEviction = (md5: string) => {
      const existing = evictionTimers.current.get(md5);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        evictionTimers.current.delete(md5);
        setDownloads((prev) => {
          const next = new Map(prev);
          next.delete(md5);
          return next;
        });
      }, TERMINAL_RETENTION_MS);
      evictionTimers.current.set(md5, timer);
    };

    const handleUpdate = (data: DownloadStatus | DownloadStatus[]) => {
      if (cancelled) return;
      const items = Array.isArray(data) ? data : [data];

      setDownloads((prev) => {
        const next = new Map(prev);
        for (const d of items) {
          next.set(d.md5, d);
        }
        return next;
      });

      for (const d of items) {
        if (isTerminal(d.status)) {
          scheduleEviction(d.md5);
        }
      }
    };

    async function init() {
      if (!window.sanCitro) {
        console.error(
          "[useDownloadStream] window.sanCitro is not defined — preload script may have failed"
        );
        if (!cancelled) setIsConnected(false);
        return;
      }

      try {
        // Fetch initial state
        const initial = await window.sanCitro.getDownloads();
        if (cancelled) return;
        if (initial.length > 0) {
          handleUpdate(initial);
        }

        // Subscribe to live progress events
        const unsub = window.sanCitro.onDownloadProgress?.(handleUpdate);
        if (cancelled) {
          // Component unmounted during async init — clean up immediately
          unsub?.();
          return;
        }
        if (unsub) {
          unsubscribe = unsub;
        }
        setIsConnected(true);
      } catch (err) {
        console.error("[useDownloadStream] Failed to initialise IPC subscription:", err);
        if (!cancelled) setIsConnected(false);
      }
    }

    init();

    return () => {
      cancelled = true;
      unsubscribe?.();
      // Clean up all eviction timers on unmount
      for (const timer of evictionTimers.current.values()) {
        clearTimeout(timer);
      }
      evictionTimers.current.clear();
    };
  }, []);

  const removeDownloads = useCallback((md5s: string[]) => {
    setDownloads((prev) => {
      const next = new Map(prev);
      for (const md5 of md5s) {
        next.delete(md5);
        const timer = evictionTimers.current.get(md5);
        if (timer) {
          clearTimeout(timer);
          evictionTimers.current.delete(md5);
        }
      }
      return next;
    });
  }, []);

  return { downloads, isConnected, removeDownloads };
}
