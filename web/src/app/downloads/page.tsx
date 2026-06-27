"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadIcon, XIcon, WifiOffIcon, Trash2Icon, XCircleIcon, FolderOpenIcon, BookOpenIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/alert";
import { ConnectionIndicator } from "@/components/connection-indicator";

import { useDownloadStream } from "@/lib/use-sse";
import { cancelDownload } from "@/lib/api-client";
import { truncateMd5, formatFileSize } from "@/lib/format";
import { getStatusVariant, STATUS_LABELS } from "@/lib/status";
import { trackInteraction, trackDownload, trackFeatureDiscovery, incrementEngagement } from "@/lib/telemetry";
import type { DownloadStatus } from "@/types";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalSec = Math.round(seconds);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

// Exponential moving average weight for speed smoothing (higher = more responsive,
// lower = smoother). 0.2 gives ~5-sample effective window.
const EMA_ALPHA = 0.2;

function DownloadCard({
  dl,
  onCancel,
  queuePosition,
  now,
  cardRef,
}: {
  dl: DownloadStatus;
  onCancel: () => void;
  queuePosition?: number;
  /** Shared 1s tick (epoch seconds) hoisted to the parent — one timer for all cards. */
  now: number;
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  // Immediate "Cancelling…" state — shown as soon as Cancel is clicked, before IPC resolves
  const [cancelling, setCancelling] = useState(false);

  // EMA speed tracking: store prev bytes + time to compute delta-based speed
  const prevSampleRef = useRef<{ bytes: number; time: number } | null>(null);
  const emaSpeedRef = useRef<number>(0);
  const [displayedSpeed, setDisplayedSpeed] = useState(0);

  const isActive = dl.status === "downloading" || dl.status === "started";
  // "Indeterminate" phase: active but no bytes progress yet (queued->started ramp-up)
  const isIndeterminate = isActive && (dl.progress_percent ?? 0) <= 0;

  // Recompute EMA speed each shared tick (no per-card interval).
  useEffect(() => {
    if (!isActive) {
      prevSampleRef.current = null;
      emaSpeedRef.current = 0;
      const reset = setTimeout(() => setDisplayedSpeed(0), 0);
      return () => clearTimeout(reset);
    }
    const prev = prevSampleRef.current;
    if (prev) {
      const dt = now - prev.time;
      const db = dl.downloaded_bytes - prev.bytes;
      if (dt > 0) {
        const instantSpeed = db / dt;
        emaSpeedRef.current =
          emaSpeedRef.current === 0
            ? instantSpeed
            : EMA_ALPHA * instantSpeed + (1 - EMA_ALPHA) * emaSpeedRef.current;
        const next = emaSpeedRef.current;
        const t = setTimeout(() => setDisplayedSpeed(next), 0);
        prevSampleRef.current = { bytes: dl.downloaded_bytes, time: now };
        return () => clearTimeout(t);
      }
    }
    prevSampleRef.current = { bytes: dl.downloaded_bytes, time: now };
  }, [isActive, now, dl.downloaded_bytes]);

  // Reset cancelling flag when backend confirms cancellation or failure.
  const dlStatus = dl.status;
  useEffect(() => {
    if (dlStatus === "cancelled" || dlStatus === "failed") {
      const t = setTimeout(() => setCancelling(false), 0);
      return () => clearTimeout(t);
    }
  }, [dlStatus]);

  const elapsed = dl.started_at ? Math.max(0, now - dl.started_at) : 0;
  const remaining =
    displayedSpeed > 0 && dl.total_bytes > dl.downloaded_bytes
      ? (dl.total_bytes - dl.downloaded_bytes) / displayedSpeed
      : null;
  // Suppress ETA until we have > 3s of elapsed to avoid wild initial estimates
  const showEta = elapsed > 3 && remaining !== null;

  const handleCancel = () => {
    setCancelling(true);
    onCancel();
  };

  return (
    <Card
      ref={cardRef}
      tabIndex={-1}
      className="outline-none motion-safe:animate-[card-enter_200ms_ease-out] transition-shadow hover:shadow-md active:shadow-sm"
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-snug line-clamp-2">
            {dl.title || "Untitled"}
          </CardTitle>
          <Badge variant={getStatusVariant(dl.status)}>
            {cancelling ? "Cancelling…" : (STATUS_LABELS[dl.status] ?? dl.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="font-mono text-xs text-muted-foreground/60">
          {truncateMd5(dl.md5)}
        </div>

        {queuePosition != null && dl.status === "queued" && (
          <div className="text-xs text-muted-foreground">
            {queuePosition === 1 ? "Next in queue" : `${queuePosition} ahead in queue`}
          </div>
        )}

        {/* Progress bar */}
        {isActive && (
          <div className="space-y-1.5">
            <div
              role="progressbar"
              aria-valuenow={isIndeterminate ? undefined : Math.round(dl.progress_percent ?? 0)}
              aria-valuemin={0}
              aria-valuemax={isIndeterminate ? undefined : 100}
              aria-label={`Download progress for ${dl.title || "file"}`}
              className="relative h-1.5 w-full rounded-full bg-muted"
            >
              {isIndeterminate ? (
                /* Indeterminate pulse during queued->started ramp-up */
                <div className="h-full w-full overflow-hidden rounded-full bg-primary/40 motion-safe:animate-pulse" />
              ) : (
                <>
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                    style={{ width: `${dl.progress_percent ?? 0}%` }}
                  />
                  {/* Traveling indicator — the flight-status "journey" feel, themed to tokens */}
                  <div
                    className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card transition-[left] duration-300 ease-out"
                    style={{ left: `${dl.progress_percent ?? 0}%` }}
                  >
                    <span className="absolute inset-0 rounded-full bg-primary/40 motion-safe:animate-ping" />
                  </div>
                </>
              )}
            </div>
            {!isIndeterminate && (
              <>
                {/* Bytes + percent — announced via progressbar aria-valuenow; suppress live text updates */}
                <div
                  className="flex items-center justify-between text-xs text-muted-foreground"
                  aria-hidden="true"
                >
                  <span>
                    {formatFileSize(dl.downloaded_bytes)}
                    {dl.total_bytes > 0 && (
                      <span className="opacity-60"> / {formatFileSize(dl.total_bytes)}</span>
                    )}
                  </span>
                  <span>{(dl.progress_percent ?? 0).toFixed(0)}%</span>
                </div>
                {/* Speed / ETA updates every second — too noisy for aria-live; hidden from AT */}
                <div
                  className="flex items-center justify-between text-xs text-muted-foreground"
                  aria-hidden="true"
                >
                  <span>
                    {elapsed > 0 && <>Elapsed: {formatDuration(elapsed)}</>}
                  </span>
                  <span>
                    {displayedSpeed > 0 && <>{formatFileSize(Math.round(displayedSpeed))}/s</>}
                    {showEta ? <> · ETA {formatDuration(remaining!)}</> : <> · ETA —</>}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {dl.status === "completed" && dl.filename && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground truncate flex-1" title={dl.filename}>
              {dl.filename}
            </span>
            {dl.filename.toLowerCase().endsWith(".epub") && dl.md5 && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-xs"
                onClick={() => openReader(dl.md5, dl.title || dl.filename || "")}
                aria-label={`Read ${dl.title || dl.filename}`}
              >
                <BookOpenIcon className="size-3.5" />
                Read
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-xs"
              onClick={() => {
                if (window.sanCitro?.showItemInFolder && dl.md5) {
                  window.sanCitro.showItemInFolder(dl.md5);
                }
              }}
              aria-label={`Show ${dl.filename} in folder`}
            >
              <FolderOpenIcon className="size-3.5" />
              Show
            </Button>
          </div>
        )}

        {dl.error && (
          <div className="text-xs text-destructive truncate" title={dl.error}>
            {dl.error}
          </div>
        )}

        {dl.status !== "completed" && dl.status !== "failed" && dl.status !== "cancelled" && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-destructive hover:text-destructive"
            onClick={handleCancel}
            disabled={cancelling}
            aria-label={`Cancel download ${dl.md5}`}
          >
            <XIcon className="size-3.5" />
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function openReader(md5: string, title: string) {
  sessionStorage.setItem("reader:md5", md5);
  sessionStorage.setItem("reader:title", title || "");
  window.location.href = "/reader";
}

export default function DownloadsPage() {
  const { downloads, connection, removeDownloads } = useDownloadStream();
  const items = Array.from(downloads.values());

  const active = items.filter((d) => d.status === "downloading" || d.status === "started");
  const queued = items.filter((d) => d.status === "queued");
  const terminal = items.filter((d) =>
    d.status === "completed" || d.status === "failed" || d.status === "cancelled"
  );

  const [cancelError, setCancelError] = useState<string | null>(null);
  // Two-step confirm so a single click can't wipe the whole queue.
  const [confirmingCancelAll, setConfirmingCancelAll] = useState(false);

  // Single shared 1s tick for all cards' elapsed/ETA/speed, replacing one
  // setInterval per active card.
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (active.length === 0) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [active.length]);

  // Focus targets so removing a card (cancel/clear) doesn't drop focus to <body>.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const registerCard = useCallback((md5: string, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(md5, el);
    else cardRefs.current.delete(md5);
  }, []);

  // After a card is removed, move focus to the next remaining card, else the heading.
  const focusAfterRemoval = useCallback((removedMd5s: string[]) => {
    const order = Array.from(downloads.keys());
    const remaining = order.filter((md5) => !removedMd5s.includes(md5));
    const target = remaining
      .map((md5) => cardRefs.current.get(md5))
      .find((el): el is HTMLDivElement => !!el);
    requestAnimationFrame(() => (target ?? headingRef.current)?.focus());
  }, [downloads]);

  const handleCancel = async (md5: string) => {
    setCancelError(null);
    try {
      await cancelDownload(md5);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Failed to cancel download");
    }
  };

  const handleClearCompleted = () => {
    const removed = terminal.map((d) => d.md5);
    trackInteraction("clear_completed", "downloads", { count: terminal.length });
    removeDownloads(removed);
    focusAfterRemoval(removed);
  };

  const handleCancelAll = async () => {
    setConfirmingCancelAll(false);
    trackInteraction("cancel_all", "downloads", { count: active.length + queued.length });
    setCancelError(null);
    const nonTerminal = items.filter((d) =>
      d.status !== "completed" && d.status !== "failed" && d.status !== "cancelled"
    );
    const results = await Promise.allSettled(
      nonTerminal.map((d) => cancelDownload(d.md5))
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    if (failures.length > 0) {
      const reasons = failures
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .slice(0, 3)
        .join("; ");
      const noun = failures.length === 1 ? "download" : "downloads";
      setCancelError(
        `Failed to cancel ${failures.length} ${noun}: ${reasons}`
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="sr-only">
            Downloads
          </h1>
        </div>
        <ConnectionIndicator connection={connection} />
      </div>

      {cancelError && (
        <Banner
          variant="error"
          onDismiss={() => setCancelError(null)}
        >
          {cancelError} — you can try cancelling again from the card.
        </Banner>
      )}

      {items.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            {active.length > 0 && <span>{active.length} active</span>}
            {queued.length > 0 && <span>{queued.length} queued</span>}
            {terminal.length > 0 && <span>{terminal.length} done</span>}
          </div>
          <div className="flex items-center gap-2">
            {terminal.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClearCompleted}>
                <Trash2Icon className="size-3.5" />
                Clear finished
              </Button>
            )}
            {(active.length + queued.length) > 0 && (
              <>
                {/* Separator keeps the destructive action visually apart from Clear Done */}
                {terminal.length > 0 && (
                  <span aria-hidden="true" className="h-5 w-px bg-border" />
                )}
                {confirmingCancelAll ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Cancel all?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleCancelAll}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingCancelAll(false)}
                    >
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmingCancelAll(true)}
                  >
                    <XCircleIcon className="size-3.5" />
                    Cancel All
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          {connection === "disconnected" ? (
            <>
              <WifiOffIcon className="size-12 mb-4 text-muted-foreground/40" />
              <p className="text-sm">Lost connection to the download stream</p>
            </>
          ) : connection === "connecting" ? (
            <>
              <WifiOffIcon className="size-12 mb-4 text-muted-foreground/40" />
              <p className="text-sm">Connecting to download stream...</p>
            </>
          ) : (
            <>
              <DownloadIcon className="size-12 mb-4 text-muted-foreground/40" />
              <p className="text-sm">No active downloads</p>
              <Button variant="outline" size="sm" className="mt-4" render={<a href="/search" />}>
                <DownloadIcon className="size-3.5" />
                Start a download from Search
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(() => {
            let queueIdx = 0;
            return items.map((dl) => {
              const pos = dl.status === "queued" ? ++queueIdx : undefined;
              return (
                <DownloadCard
                  key={dl.md5}
                  dl={dl}
                  now={now}
                  cardRef={(el) => registerCard(dl.md5, el)}
                  queuePosition={pos}
                  onCancel={() => handleCancel(dl.md5)}
                />
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
