"use client";

import { useCallback, useEffect, useState } from "react";

import {
  checkForUpdates as apiCheckForUpdates,
  getUpdateStatus,
  onUpdateStatus,
  quitAndInstall as apiQuitAndInstall,
} from "@/lib/api-client";
import type { UpdateStatus } from "@/types";

/** Default snapshot before first hydrate / live push. */
export const INITIAL_RENDERER_UPDATE_STATUS: UpdateStatus = { status: "idle" };

export type UseUpdateStatusResult = {
  /** Latest update snapshot from hydrate + live pushes. */
  status: UpdateStatus;
  /**
   * True only when the installer is fully downloaded.
   * Restart must never be offered for `available` or `downloading` alone.
   */
  isReadyToInstall: boolean;
  /**
   * Trigger a feed check. Does **not** write the return value into local state —
   * live pushes (and a subsequent hydrate) remain authoritative.
   */
  check: () => Promise<UpdateStatus>;
  /** Install a downloaded update and restart (no-op-safe if not ready). */
  restart: () => void;
};

/**
 * Single renderer ownership seam for update status (issue #49).
 *
 * - Subscribes to live pushes immediately.
 * - Hydrates from `getUpdateStatus` so a missed push still surfaces Restart.
 * - Uses a live generation counter so a slower hydration cannot overwrite a
 *   newer pushed state (classic subscribe-before-hydrate race).
 *
 * Settings and UpdateBanner must both consume this hook — do not invent a
 * second updater store.
 */
export function useUpdateStatus(): UseUpdateStatusResult {
  const [status, setStatus] = useState<UpdateStatus>(
    INITIAL_RENDERER_UPDATE_STATUS
  );

  useEffect(() => {
    let cancelled = false;
    /** Bumped only on live pushes; hydrate applies only when unchanged. */
    let liveGeneration = 0;
    let unsubscribe: (() => void) | undefined;

    const applyLive = (next: UpdateStatus) => {
      if (cancelled) return;
      liveGeneration += 1;
      setStatus(next);
    };

    try {
      // Subscribe first so in-flight download → downloaded is not missed
      // while getUpdateStatus is outstanding.
      unsubscribe = onUpdateStatus(applyLive);

      const generationAtHydrateStart = liveGeneration;
      void getUpdateStatus()
        .then((snapshot) => {
          if (cancelled) return;
          // Stale hydrate must not clobber a newer live push.
          if (liveGeneration !== generationAtHydrateStart) return;
          setStatus(snapshot);
        })
        .catch(() => {
          /* bridge unavailable — leave idle */
        });
    } catch {
      // IPC bridge unavailable (e.g. plain browser dev) — stay idle.
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const check = useCallback(async (): Promise<UpdateStatus> => {
    return apiCheckForUpdates();
  }, []);

  const restart = useCallback(() => {
    void apiQuitAndInstall();
  }, []);

  return {
    status,
    isReadyToInstall: status.status === "downloaded",
    check,
    restart,
  };
}
