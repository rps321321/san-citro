"use client";

import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getUpdateStatus,
  onUpdateStatus,
  quitAndInstall,
} from "@/lib/api-client";
import type { UpdateStatus } from "@/types";

/**
 * Slim global banner shown once an update has fully downloaded. Clicking
 * "Restart" installs via electron-updater. Hydrates from getUpdateStatus so a
 * missed push (or "available" snapshot from checkForUpdates) still surfaces
 * Restart after download completes.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus["status"]>("idle");
  const [version, setVersion] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const apply = (s: UpdateStatus) => {
      if (cancelled) return;
      setStatus(s.status);
      setVersion(s.version);
    };

    try {
      unsubscribe = onUpdateStatus(apply);
      void getUpdateStatus()
        .then(apply)
        .catch(() => {
          /* bridge unavailable */
        });
    } catch {
      // IPC bridge unavailable (e.g. dev in a plain browser) — stay hidden.
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  if (status !== "downloaded") return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-success/30 bg-success/10 px-4 py-2 text-sm text-success"
    >
      <RefreshCwIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="flex-1">
        Update ready{version ? ` (v${version})` : ""} — restart to install.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-success/40 text-success hover:text-success"
        onClick={() => quitAndInstall()}
      >
        Restart
      </Button>
    </div>
  );
}
