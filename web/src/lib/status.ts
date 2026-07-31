import type { LiveDownloadStatus } from "@/types";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "success" | "warning";

/**
 * Durable / history-only values → public Download lifecycle alphabet
 * (CONTEXT.md: queued | downloading | completed | failed | cancelled).
 *
 * Sole renderer coercion table. Keep in sync with
 * ``normalize_download_status`` in ``src/download_lifecycle.py``.
 *
 * ``interrupted`` is intentionally absent: history-only, not a live public status.
 */
const DURABLE_TO_PUBLIC: Readonly<Record<string, LiveDownloadStatus>> = {
  started: "downloading",
};

/** Public live Download lifecycle statuses (no history-only values). */
export const PUBLIC_DOWNLOAD_STATUSES: readonly LiveDownloadStatus[] = [
  "queued",
  "downloading",
  "completed",
  "failed",
  "cancelled",
] as const;

/**
 * Map durable/history statuses onto the public Download lifecycle alphabet.
 * Live UI must never treat ``started`` as a first-class live status; history
 * rows may still store it from ``record_download_start``. Unknown and
 * history-only values (e.g. ``interrupted``) pass through unchanged.
 */
export function normalizeDownloadStatus(status: string): LiveDownloadStatus | string {
  if (Object.prototype.hasOwnProperty.call(DURABLE_TO_PUBLIC, status)) {
    return DURABLE_TO_PUBLIC[status];
  }
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
