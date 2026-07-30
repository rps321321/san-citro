import type { LiveDownloadStatus } from "@/types";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "success" | "warning";

/**
 * Map legacy / history-only DB statuses onto the public Download lifecycle
 * vocabulary (CONTEXT.md). Live UI must never treat ``started`` as a first-class
 * live status; history rows may still store it from ``record_download_start``.
 */
export function normalizeDownloadStatus(status: string): LiveDownloadStatus | string {
  if (status === "started") return "downloading";
  return status;
}

/**
 * Maps a download status to a Badge variant. Single source of truth shared by
 * the Downloads and History pages so their status pills stay consistent.
 */
export function getStatusVariant(status: string): BadgeVariant {
  switch (normalizeDownloadStatus(status)) {
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    case "downloading":
      return "default";
    case "queued":
    case "cancelled":
    default:
      return "outline";
  }
}

/** Human-readable labels for public Download lifecycle statuses. */
export const STATUS_LABELS: Record<LiveDownloadStatus, string> = {
  queued: "Queued",
  downloading: "Downloading",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Label for live or history rows (maps legacy ``started`` → Downloading). */
export function getStatusLabel(status: string): string {
  const normalized = normalizeDownloadStatus(status);
  if (normalized in STATUS_LABELS) {
    return STATUS_LABELS[normalized as LiveDownloadStatus];
  }
  if (status === "interrupted") return "Interrupted";
  return status;
}
