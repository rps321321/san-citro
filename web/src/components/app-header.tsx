"use client";

import { useSyncExternalStore } from "react";
import { DownloadIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useDownloadStream } from "@/lib/use-sse";

const PAGE_TITLES: Record<string, string> = {
  "/search": "Search",
  "/downloads": "Downloads",
  "/history": "History",
  "/settings": "Settings",
};

function titleForPath(pathname: string): string {
  // Home ("/") re-exports the search page, so treat it as /search.
  const normalized = pathname === "/" ? "/search" : pathname;
  const match = Object.keys(PAGE_TITLES).find((href) => normalized.startsWith(href));
  return match ? PAGE_TITLES[match] : "San Citro";
}

export function AppHeader() {
  // Read pathname the same way app-sidebar does — next/navigation hooks are
  // unreliable under Electron's san-citro:// protocol. Location never changes
  // without a full reload, so subscribe is a no-op.
  const pathname = useSyncExternalStore(
    () => () => {},
    () => window.location.pathname,
    () => ""
  );
  const { downloads } = useDownloadStream();

  const activeCount = Array.from(downloads.values()).filter(
    (d) => d.status === "downloading" || d.status === "started" || d.status === "queued"
  ).length;

  return (
    <header className="app-region-drag flex h-12 items-center gap-2 border-b pl-4 pr-[140px]">
      <h1 className="text-sm font-semibold tracking-tight">{titleForPath(pathname)}</h1>
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
