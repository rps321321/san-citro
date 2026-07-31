"use client";

import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUpdateStatus } from "@/hooks/use-update-status";

/**
 * Slim global banner shown once an update has fully downloaded. Clicking
 * "Restart" installs via electron-updater. Status comes from the shared
 * `useUpdateStatus` seam (hydrate + live pushes) so a missed push still
 * surfaces Restart — and "available" alone never does.
 */
export function UpdateBanner() {
  const { status, isReadyToInstall, restart } = useUpdateStatus();

  if (!isReadyToInstall) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-success/30 bg-success/10 px-4 py-2 text-sm text-success"
    >
      <RefreshCwIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="flex-1">
        Update ready{status.version ? ` (v${status.version})` : ""} — restart to
        install.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-success/40 text-success hover:text-success"
        onClick={() => restart()}
      >
        Restart
      </Button>
    </div>
  );
}
