"""Thread-based download manager for the JSON-RPC bridge.

Tracks active downloads in a dict keyed by MD5 hash. Each download runs on
its own daemon thread. Single-job lifecycle (history, cancel, progress, status
stream, Terminal event fact) lives in ``src.download_lifecycle``; this module
owns concurrency slots, the in-memory entry map, and IPC fan-out to the renderer.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from src.config_manager import clamp_concurrency, get_config
from src.download_history import record_download_cancelled
from src.download_lifecycle import TERMINAL_RETENTION_S, build_terminal_fact, run_download
from src.download_strategy import create_strategy

logger = logging.getLogger("bridge.download_manager")


@dataclass
class DownloadEntry:
    """Mutable state for a single in-flight download."""

    md5: str
    title: str
    status: str = "queued"  # queued | downloading | completed | failed | cancelled
    progress_percent: float = 0.0  # 0..100
    total_bytes: int = 0
    downloaded_bytes: int = 0
    error: str | None = None
    cancel_flag: threading.Event = field(default_factory=threading.Event)
    file_path: str | None = None
    started_at: float | None = None  # unix timestamp
    # Set once when status first becomes completed|failed|cancelled (live retention clock).
    terminal_at: float | None = None
    telemetry_emitted: bool = False  # guard: download_analytics row sent once
    meta: dict[str, Any] = field(default_factory=dict)  # search-result metadata; not serialised
    # Set when the worker thread fully exits (including after queue-only cancel).
    # Prevents re-enqueue from spawning a second writer for the same md5 while an
    # older worker is still waiting on the concurrency slot or winding down.
    finished: threading.Event = field(default_factory=threading.Event)

    def terminal_expires_at(self) -> float | None:
        """Backend-owned Active-downloads eviction deadline (unix seconds)."""
        if self.terminal_at is None:
            return None
        return self.terminal_at + TERMINAL_RETENTION_S

    def to_dict(self) -> dict[str, Any]:
        return {
            "md5": self.md5,
            "title": self.title,
            "status": self.status,
            "progress_percent": round(self.progress_percent, 1),
            "total_bytes": self.total_bytes,
            "downloaded_bytes": self.downloaded_bytes,
            "error": self.error,
            "filename": os.path.basename(self.file_path) if self.file_path else None,
            "file_path": self.file_path,
            "started_at": self.started_at,
            "terminal_at": self.terminal_at,
            "terminal_expires_at": self.terminal_expires_at(),
        }


# Module-level state guarded by a lock
_lock = threading.Lock()
_downloads: dict[str, DownloadEntry] = {}
_concurrency_sem: threading.Semaphore | None = None


def _get_concurrency_semaphore() -> threading.Semaphore:
    """Lazy-init a semaphore from the configured concurrency setting."""
    global _concurrency_sem
    if _concurrency_sem is None:
        config = get_config()
        limit = clamp_concurrency(config.get("concurrency", 2))
        _concurrency_sem = threading.Semaphore(limit)
    return _concurrency_sem


def reset_concurrency_semaphore() -> None:
    """Discard the cached semaphore so the next download picks up the new config value.

    In-flight downloads hold the old semaphore and will complete normally.
    New downloads queued after this call will use the updated concurrency limit.
    """
    global _concurrency_sem
    with _lock:
        _concurrency_sem = None


def _get_send_event():
    """Lazy import to avoid circular dependency with bridge.py."""
    from bridge import send_event

    return send_event


_TERMINAL_RETENTION_S = TERMINAL_RETENTION_S  # Auto-prune terminal entries after retention


def _mark_terminal(entry: DownloadEntry, now: float | None = None) -> None:
    """Stamp terminal_at once when a live entry first becomes terminal.

    Must be called with _lock held. Retries create a new entry (or clear via
    ``_clear_terminal``) so the deadline is never reused across jobs.
    """
    if entry.terminal_at is None:
        entry.terminal_at = time.time() if now is None else now


def _clear_terminal(entry: DownloadEntry) -> None:
    """Drop terminal retention deadline (non-terminal / retry path)."""
    entry.terminal_at = None


def _prune_terminal() -> None:
    """Remove completed/failed/cancelled entries past their terminal deadline.

    Uses ``terminal_at`` (when status first became terminal), never
    ``started_at`` — a long download must remain visible for the full retention
    window after completion.

    Must be called with _lock held.
    """
    now = time.time()
    stale = [
        md5
        for md5, e in _downloads.items()
        if e.status in ("completed", "failed", "cancelled")
        and e.terminal_at is not None
        and now >= (e.terminal_at + _TERMINAL_RETENTION_S)
    ]
    for md5 in stale:
        del _downloads[md5]


def _background_prune_loop() -> None:
    """Daemon thread: prune stale terminal entries every 5 minutes.

    This ensures memory is reclaimed even when no new downloads are enqueued
    (previously pruning only happened inside enqueue()).
    """
    while True:
        time.sleep(_TERMINAL_RETENTION_S)
        with _lock:
            _prune_terminal()


# Start the background prune daemon at module import time.
_prune_thread = threading.Thread(
    target=_background_prune_loop,
    daemon=True,
    name="dl-prune",
)
_prune_thread.start()


_TERMINAL_STATES = ("completed", "failed", "cancelled")

# Desktop always enqueues with chrome strategy (auto-fallback inside transport).
_DESKTOP_STRATEGY = "chrome"


def _emit_queue_only_terminal(entry: DownloadEntry) -> None:
    """Emit Terminal event once for queue-only cancel (lifecycle never ran).

    Lifecycle owns fact construction for jobs that enter ``run_download``.
    Queue-only cancel (cancelled while waiting for a concurrency slot, never
    entered the worker body) never reaches lifecycle, so this is the sole
    remaining manager path. Guarded by ``entry.telemetry_emitted``.
    """
    if entry.telemetry_emitted or entry.status not in _TERMINAL_STATES:
        return
    entry.telemetry_emitted = True

    try:
        import telemetry_emitter

        fact = build_terminal_fact(
            md5=entry.md5,
            title=entry.title,
            status=entry.status,
            started_at=entry.started_at,
            file_path=entry.file_path,
            total_bytes=entry.total_bytes,
            error=entry.error,
            strategy=_DESKTOP_STRATEGY,
            mirror_domain=None,
            proxy_used=bool(get_config().get("proxies")),
        )
        telemetry_emitter.emit("download_analytics", fact)
    except Exception:
        # Telemetry must never break a download.
        logger.warning("download_analytics telemetry emit failed", exc_info=True)


def enqueue(md5: str, title: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Queue a new download and spawn its worker thread.

    Returns the initial status dict immediately.
    """
    with _lock:
        _prune_terminal()  # Prevent unbounded dict growth
        existing = _downloads.get(md5)
        if existing is not None:
            # Active job: idempotent return.
            if existing.status in ("queued", "downloading"):
                return existing.to_dict()
            # Terminal in the UI but worker still alive (queued-behind-slot cancel,
            # mid-flight cancel, or post-terminal cleanup). Replacing the map entry
            # would start a second worker against the same md5/.part file.
            if not existing.finished.is_set():
                return existing.to_dict()

        entry = DownloadEntry(md5=md5, title=title, meta=meta or {})
        _downloads[md5] = entry
        result = entry.to_dict()

    t = threading.Thread(
        target=_download_worker,
        args=(md5, entry),
        daemon=True,
        name=f"dl-{md5[:8]}",
    )
    t.start()
    return result


def cancel(md5: str) -> dict[str, Any]:
    """Set the cancel flag for an active download.

    Lifecycle is the sole history writer once the worker is running
    (``downloading``). Queue-only cancel (never entered the worker body) may
    record cancel history here so the row is not left open.

    Terminal event: lifecycle owns facts for jobs that enter ``run_download``.
    Queue-only cancel may still emit once here (lifecycle never runs).
    """
    was_queued_only = False
    was_active = False
    with _lock:
        entry = _downloads.get(md5)
        if entry is None:
            return {"md5": md5, "error": "No such download"}
        prior_status = entry.status
        entry.cancel_flag.set()
        if entry.status in ("queued", "downloading"):
            # Snappy UI: reflect cancel immediately in the live map.
            entry.status = "cancelled"
            _mark_terminal(entry)
            was_active = True
            # History + queue-only terminal: only when lifecycle will not also run.
            was_queued_only = prior_status == "queued"
            if was_queued_only:
                # Worker never entered transport (may still be blocked on the
                # concurrency slot). Mark finished so a retry can re-enqueue
                # immediately; the stale worker no-ops via entry-identity check.
                entry.finished.set()
                _emit_queue_only_terminal(entry)
        result = entry.to_dict()

    if was_queued_only:
        config = get_config()
        history_db = config.get("history_db")
        record_download_cancelled(db_path=history_db, md5=md5)

    if was_active:
        send_event = _get_send_event()
        send_event("download_progress", result)

    return result


def get_all_statuses() -> list[dict[str, Any]]:
    """Return status dicts for every tracked download."""
    with _lock:
        return [e.to_dict() for e in _downloads.values()]


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


def _download_worker(md5: str, entry: DownloadEntry) -> None:
    """Run on a background thread: perform the download and emit events.

    Acquires a concurrency semaphore so at most N downloads run simultaneously.
    The entry stays in "queued" status while waiting for a slot.

    ``entry`` is the exact object this worker owns. After the slot is acquired we
    re-check map identity so a superseded worker never adopts a newer entry.
    """
    sem = _get_concurrency_semaphore()
    send_event = _get_send_event()

    try:
        # Wait for a concurrency slot — entry stays "queued" during this time
        sem.acquire()
        try:
            with _lock:
                # Map was replaced (or pruned) while we waited — do not touch the
                # newer job or re-enter run_download for a cancelled predecessor.
                if _downloads.get(md5) is not entry:
                    return
            _download_worker_inner(md5, entry, send_event)
        finally:
            sem.release()
    finally:
        entry.finished.set()


def _download_worker_inner(md5: str, entry: DownloadEntry, send_event) -> None:
    """Inner download logic, runs after concurrency slot is acquired.

    Delegates the full tracked lifecycle (history records + terminal-state
    guard + progress + Terminal event fact) to ``download_lifecycle.run_download``.
    The ``on_status`` sink mirrors each emitted payload into the ``DownloadEntry``
    (for ``get_all_statuses``) and forwards it to the renderer as a
    ``download_progress`` event. Byte progress comes from the lifecycle
    progress sink — no ``.part`` file polling. Terminal analytics are delivered
    via ``on_terminal_fact`` (wired to ``telemetry_emitter``).
    """
    with _lock:
        if _downloads.get(md5) is not entry:
            return
        # Check if cancelled while waiting in queue
        if entry.cancel_flag.is_set():
            entry.status = "cancelled"
            _mark_terminal(entry)
            # cancel() may already have emitted; guard keeps terminal-once.
            _emit_queue_only_terminal(entry)
            send_event("download_progress", entry.to_dict())
            return
        entry.status = "downloading"
        entry.started_at = time.time()
        _clear_terminal(entry)

    send_event("download_progress", entry.to_dict())

    config = get_config()
    out_dir = config.get("out_dir", "downloads")
    history_db = config.get("history_db")

    def on_status(payload: dict[str, Any]) -> None:
        """Mirror a run_download payload into the entry and emit to renderer."""
        with _lock:
            entry.status = payload["status"]
            entry.error = payload.get("error")
            if payload.get("file_path"):
                entry.file_path = payload["file_path"]
            if payload.get("total_bytes") is not None:
                entry.total_bytes = payload["total_bytes"]
            if payload.get("downloaded_bytes") is not None:
                entry.downloaded_bytes = payload["downloaded_bytes"]
            entry.progress_percent = payload.get("progress_percent", entry.progress_percent)
            # Retention clock starts when status first becomes terminal.
            if entry.status in _TERMINAL_STATES:
                _mark_terminal(entry)
            else:
                _clear_terminal(entry)
            # Enrich progress payload with backend-owned eviction deadline so the
            # renderer does not dual-maintain a retention constant.
            out = dict(payload)
            out["terminal_at"] = entry.terminal_at
            out["terminal_expires_at"] = entry.terminal_expires_at()
            # Lifecycle owns Terminal event emission via on_terminal_fact.
            # Category-after-Artifact is wired through on_completed (not here).
        send_event("download_progress", out)

    def on_terminal_fact(fact: dict[str, Any]) -> None:
        """Bridge sink: mark entry and forward to Python-bridge telemetry emitter."""
        with _lock:
            if entry.telemetry_emitted:
                return
            entry.telemetry_emitted = True
        try:
            import telemetry_emitter

            telemetry_emitter.emit("download_analytics", fact)
        except Exception:
            logger.warning("download_analytics telemetry emit failed", exc_info=True)

    def on_completed(job_md5: str, file_path: str, completed_out_dir: str) -> None:
        """Category-after-Artifact: classify once, stamp media_type, enqueue if audio.

        Runs after download terminal (bytes done). Uses authoritative
        classify/list_archive — never stamps Book solely because the file is
        not a zip. media_type is stamped here once; the queue does not re-stamp.
        """
        try:
            import audiobook_queue
            from src.audiobook_processor import apply_category_after_artifact

            apply_category_after_artifact(
                job_md5,
                file_path,
                completed_out_dir,
                db_path=history_db,
                enqueue_fn=audiobook_queue.enqueue,
            )
        except Exception:
            logger.warning(
                "category-after-artifact failed for %s",
                job_md5[:8],
                exc_info=True,
            )

    run_download(
        md5=md5,
        title=entry.title,
        out_dir=out_dir,
        history_db=history_db,
        # Chrome strategy drives a real browser through the slow_download JS
        # countdown, which is what gets past Anna's Archive's anti-bot 403 on
        # the download endpoint WITHOUT a VPN. It auto-falls back to direct
        # HTTP if no browser/driver is available. (Supersedes the earlier
        # 'direct' default — see H5; the bundle now ships the driver.)
        strategy=create_strategy("chrome", proxies=config.get("proxies")),
        proxies=config.get("proxies"),
        on_status=on_status,
        cancel=entry.cancel_flag,
        meta=entry.meta,
        on_terminal_fact=on_terminal_fact,
        on_completed=on_completed,
    )
