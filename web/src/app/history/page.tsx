"use client";

import { useEffect, useState } from "react";
import {
  ClockIcon,
  LoaderIcon,
  FileSpreadsheetIcon,
  FileJsonIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { getHistory } from "@/lib/api-client";
import type { HistoryEntry } from "@/types";
import { trackInteraction, trackFeatureDiscovery, incrementEngagement } from "@/lib/telemetry";
import { formatFileSize, truncateMd5, formatDate } from "@/lib/format";

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

function statusVariant(
  status: string
): "secondary" | "default" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "secondary";
    case "failed":
      return "destructive";
    case "downloading":
    case "started":
      return "default";
    default:
      return "outline";
  }
}

export default function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getHistory();
        if (!cancelled) {
          // Sort by most recent first (spread to avoid mutating the original array)
          const sorted = [...data].sort((a, b) => {
            const da = a.started_at ?? "";
            const db = b.started_at ?? "";
            return db.localeCompare(da);
          });
          setEntries(sorted);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load history");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">History</h1>
          <p className="text-sm text-muted-foreground">
            Download history and past operations
          </p>
        </div>
        {entries.length > 0 && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => exportToCsv(entries)}>
              <FileSpreadsheetIcon className="size-3.5" />
              CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportToJson(entries)}>
              <FileJsonIcon className="size-3.5" />
              JSON
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {isLoading ? (
        <div role="status" className="flex items-center justify-center py-16">
          <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
          <span className="sr-only">Loading history...</span>
        </div>
      ) : error ? null : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ClockIcon className="size-12 mb-4 opacity-30" />
          <p className="text-sm">No download history</p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">Download history</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>MD5</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry, i) => (
                <TableRow key={`${entry.md5}-${entry.started_at ?? i}`}>
                  <TableCell className="max-w-xs">
                    <span className="truncate block font-medium" title={entry.title ?? undefined}>
                      {entry.title || "Untitled"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs" title={entry.md5}>
                      {truncateMd5(entry.md5)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(entry.status)}>
                      {entry.status}
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
