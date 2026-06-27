"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClockIcon,
  FileSpreadsheetIcon,
  FileJsonIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableHead, toggleSort, type SortState } from "@/components/ui/sortable-head";

import { getHistory } from "@/lib/api-client";
import type { HistoryEntry } from "@/types";
import { trackInteraction, trackFeatureDiscovery, incrementEngagement } from "@/lib/telemetry";
import { formatFileSize, truncateMd5, formatDate } from "@/lib/format";
import { getStatusVariant, STATUS_LABELS } from "@/lib/status";

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportToCsv(entries: HistoryEntry[]): void {
  incrementEngagement("exportsCount");
  trackFeatureDiscovery("export_csv");
  trackInteraction("export_csv", "history", { count: entries.length });
  const headers = ["md5", "title", "filename", "status", "started_at", "completed_at", "filesize_bytes", "error"];
  const rows = entries.map((e) =>
    headers.map((h) => csvEscape(e[h as keyof HistoryEntry])).join(",")
  );
  const csv = "\uFEFF" + [headers.join(","), ...rows].join("\n");
  triggerDownload(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    "san-citro-history.csv"
  );
}

function exportToJson(entries: HistoryEntry[]): void {
  incrementEngagement("exportsCount");
  trackFeatureDiscovery("export_json");
  trackInteraction("export_json", "history", { count: entries.length });
  const json = JSON.stringify(entries, null, 2);
  triggerDownload(
    new Blob([json], { type: "application/json" }),
    "san-citro-history.json"
  );
}

type KnownStatus = keyof typeof STATUS_LABELS;

const KNOWN_STATUSES = new Set<string>(Object.keys(STATUS_LABELS));

/** History status can be any string; fall back to title-casing unknown values. */
function statusLabel(status: string): string {
  if (KNOWN_STATUSES.has(status)) return STATUS_LABELS[status as KnownStatus];
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusVariant(status: string) {
  return KNOWN_STATUSES.has(status)
    ? getStatusVariant(status as KnownStatus)
    : "outline";
}

// Cap rendered rows so a multi-thousand-entry history stays responsive. Export
// (CSV/JSON) still operates on the full set — only the table is windowed.
const ROW_CAP = 500;

type SortKey = "title" | "status" | "size" | "started" | "completed";

function compareEntries(a: HistoryEntry, b: HistoryEntry, key: SortKey): number {
  switch (key) {
    case "title":
      return (a.title ?? "").localeCompare(b.title ?? "");
    case "status":
      return a.status.localeCompare(b.status);
    case "size":
      return (a.filesize_bytes ?? 0) - (b.filesize_bytes ?? 0);
    case "started":
      return (a.started_at ?? "").localeCompare(b.started_at ?? "");
    case "completed":
      return (a.completed_at ?? "").localeCompare(b.completed_at ?? "");
  }
}

export default function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default view: most recent first, matching prior behavior.
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "started", direction: "desc" });

  const load = useCallback(async (refresh = false) => {
    if (refresh) setIsRefreshing(true);
    try {
      const data = await getHistory();
      setEntries(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = () => {
    trackInteraction("refresh", "history");
    void load(true);
  };

  const handleSort = (key: SortKey) => {
    setSort((prev) => toggleSort(prev, key));
    trackInteraction("sort", "history", { key });
  };

  const sortedEntries = useMemo(() => {
    const sorted = [...entries].sort((a, b) => compareEntries(a, b, sort.key));
    if (sort.direction === "desc") sorted.reverse();
    return sorted;
  }, [entries, sort]);

  const visibleEntries = sortedEntries.slice(0, ROW_CAP);
  const isCapped = sortedEntries.length > ROW_CAP;

  // Log (don't silently swallow) when the cap hides rows.
  const loggedCapRef = useRef(false);
  useEffect(() => {
    if (isCapped && !loggedCapRef.current) {
      loggedCapRef.current = true;
      console.info(
        `[history] Rendering first ${ROW_CAP} of ${sortedEntries.length} entries (capped for performance).`
      );
    }
  }, [isCapped, sortedEntries.length]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Reload history from disk"
          >
            <RefreshCwIcon className={`size-3.5${isRefreshing ? " animate-spin" : ""}`} />
            Refresh
          </Button>
          {entries.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={() => exportToCsv(entries)}>
                <FileSpreadsheetIcon className="size-3.5" />
                CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => exportToJson(entries)}>
                <FileJsonIcon className="size-3.5" />
                JSON
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 font-medium"
            onClick={handleRefresh}
          >
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div role="status" aria-label="Loading history" aria-busy="true" className="rounded-lg border overflow-x-auto">
          <span className="sr-only">Loading history...</span>
          <Table>
            <TableCaption className="sr-only">Loading history…</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead title="MD5 hash (first 8 chars)">ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-36" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-20 font-mono" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-6 rounded" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : error ? null : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ClockIcon className="size-12 mb-4 text-muted-foreground/40" />
          <p className="text-sm">No download history</p>
          <Button variant="outline" size="sm" className="mt-4" render={<a href="/search" />}>
            <SearchIcon className="size-3.5" />
            Search for something to download
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
        {isCapped && (
          <p className="text-xs text-muted-foreground" role="status">
            Showing first {ROW_CAP.toLocaleString()} of {sortedEntries.length.toLocaleString()} entries. Export to see all.
          </p>
        )}
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">Download history</TableCaption>
            <TableHeader>
              <TableRow>
                <SortableHead sortKey="title" sort={sort} onSort={handleSort}>Title</SortableHead>
                <TableHead title="MD5 hash (first 8 chars)">ID</TableHead>
                <SortableHead sortKey="status" sort={sort} onSort={handleSort}>Status</SortableHead>
                <SortableHead sortKey="size" sort={sort} onSort={handleSort}>Size</SortableHead>
                <SortableHead sortKey="started" sort={sort} onSort={handleSort}>Started</SortableHead>
                <SortableHead sortKey="completed" sort={sort} onSort={handleSort}>Completed</SortableHead>
                <TableHead>Error</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleEntries.map((entry, i) => (
                <TableRow key={`${entry.md5}-${entry.started_at ?? i}`}>
                  <TableCell className="max-w-xs">
                    <span className="truncate block font-medium" title={entry.title ?? undefined}>
                      {entry.title || "Untitled"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground/60" title={entry.md5}>
                      {truncateMd5(entry.md5)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(entry.status)}>
                      {statusLabel(entry.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatFileSize(entry.filesize_bytes)}</TableCell>
                  <TableCell className="text-xs">
                    {formatDate(entry.started_at)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDate(entry.completed_at)}
                  </TableCell>
                  <TableCell className="max-w-[12rem]">
                    {entry.error ? (
                      <span
                        className="truncate block text-xs text-destructive"
                        title={entry.error}
                      >
                        {entry.error}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {entry.status === "completed" && entry.filename && entry.md5 && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          window.sanCitro?.showItemInFolder(entry.md5);
                        }}
                        aria-label={`Show ${entry.filename} in folder`}
                        title="Show in folder"
                      >
                        <FolderOpenIcon className="size-3.5" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        </div>
      )}
    </div>
  );
}
