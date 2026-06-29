"use client";

import { DownloadIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useDownloadStream } from "@/lib/use-sse";

// No page-title text — the sidebar already shows where the user is. This header
// is just the draggable title-bar strip plus the active-downloads badge; the
// right padding reserves room for the OS window controls.
export function AppHeader() {
  const { downloads } = useDownloadStream();

  const activeCount = Array.from(downloads.values()).filter(
    (d) => d.status === "downloading" || d.status === "started" || d.status === "queued"
  ).length;

  return (
    <header className="app-region-drag flex h-12 items-center gap-2 border-b border-sidebar-border bg-sidebar pl-4 pr-[140px]">
      <div className="app-region-no-drag ml-auto flex items-center gap-3">
        {activeCount > 0 && (
          <Badge
            variant="secondary"
            render={
              <a href="/downloads" aria-label={`${activeCount} active downloads`} />
            }
          >
            <DownloadIcon />
            {activeCount}
          </Badge>
        )}
      </div>
    </header>
  );
}
