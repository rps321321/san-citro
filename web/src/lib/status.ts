import type { DownloadStatus } from "@/types";

type StatusKey = DownloadStatus["status"];

type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "success" | "warning";

/**
 * Maps a download status to a Badge variant. Single source of truth shared by
 * the Downloads and History pages so their status pills stay consistent.
 */
export function getStatusVariant(status: StatusKey): BadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    case "downloading":
    case "started":
      return "default";
    case "queued":
    case "cancelled":
    default:
      return "outline";
  }
}

/** Human-readable labels for each download status. */
export const STATUS_LABELS: Record<StatusKey, string> = {
  queued: "Queued",
  started: "Started",
  downloading: "Downloading",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
