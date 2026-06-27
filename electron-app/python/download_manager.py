"""Thread-based download manager for the JSON-RPC bridge.

Tracks active downloads in a dict keyed by MD5 hash.  Each download runs
on its own daemon thread using ``AnnasArchiveTool.automated_slow_download``.
Progress is emitted as ``download_progress`` events by polling the ``.part``
file size every 2 seconds.
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
from src.download_job import TERMINAL_RETENTION_S, run_download
from src.download_strategy import create_strategy

logger = logging.getLogger("bridge.download_manager")

# Sidecar file written by annas_archive_tool when Content-Length is known.
# Format: plain integer (bytes) on a single line.
_SIZE_SIDECAR_SUFFIX = ".size"


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
    telemetry_emitted: bool = False  # guard: download_analytics row sent once

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


_TERMINAL_RETENTION_S = TERMINAL_RETENTION_S  # Auto-prune terminal entries after 5 minutes


def _prune_terminal() -> None:
    """Remove completed/failed/cancelled entries older than retention period.

    Must be called with _lock held.
    """
    now = time.time()
    stale = [
        md5
        for md5, e in _downloads.items()
        if e.status in ("completed", "failed", "cancelled")
        and e.started_at is not None
        and (now - e.started_at) > _TERMINAL_RETENTION_S
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


def _emit_download_terminal(entry: DownloadEntry) -> None:
    """Emit a single download_analytics row when a download reaches a terminal state.

    Guarded by ``entry.telemetry_emitted`` so repeated terminal transitions emit once.
    Telemetry must never break a download, so the emit is wrapped in try/except.
    """
    if entry.telemetry_emitted or entry.status not in _TERMINAL_STATES:
        return
    entry.telemetry_emitted = True

    name = os.path.basename(entry.file_path) if entry.file_path else None
    ext = os.path.splitext(name)[1].lstrip(".").lower() if name else None
    file_size_bytes = entry.total_bytes or None
    duration_seconds = round(time.time() - entry.started_at, 1) if entry.started_at else None
    avg_speed_bps = (
        round(file_size_bytes / duration_seconds)
        if duration_seconds and file_size_bytes
        else None
    )

    try:
        import telemetry_emitter

        telemetry_emitter.emit(
            "download_analytics",
            {
                "md5": entry.md5,
                "title": entry.title,
                "extension": ext or None,
                "status": entry.status,
                "file_size_bytes": file_size_bytes,
                "duration_seconds": duration_seconds,
                "avg_speed_bps": avg_speed_bps,
                "mirror_domain": None,
                "strategy": "chrome",
                "proxy_used": bool(get_config().get("proxies")),
                "error_message": entry.error,
            },
        )
    except Exception:
        # Telemetry must never break a download.
        logger.warning("download_analytics telemetry emit failed", exc_info=True)


def enqueue(md5: str, title: str) -> dict[str, Any]:
    """Queue a new download and spawn its worker thread.

    Returns the initial status dict immediately.
    """
    with _lock:
        _prune_terminal()  # Prevent unbounded dict growth
        if md5 in _downloads and _downloads[md5].status in ("queued", "downloading"):
            return _downloads[md5].to_dict()

        entry = DownloadEntry(md5=md5, title=title)
        _downloads[md5] = entry
        result = entry.to_dict()

    t = threading.Thread(
        target=_download_worker,
        args=(md5,),
        daemon=True,
        name=f"dl-{md5[:8]}",
    )
    t.start()
    return result


def cancel(md5: str) -> dict[str, Any]:
    """Set the cancel flag for an active download."""
    was_active = False
    with _lock:
        entry = _downloads.get(md5)
        if entry is None:
            return {"md5": md5, "error": "No such download"}
        entry.cancel_flag.set()
        if entry.status in ("queued", "downloading"):
            entry.status = "cancelled"
            _emit_download_terminal(entry)
            was_active = True
        result = entry.to_dict()

    if was_active:
        config = get_config()
        history_db = config.get("history_db")
        record_download_cancelled(db_path=history_db, md5=md5)

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


def _download_worker(md5: str) -> None:
    """Run on a background thread: perform the download and emit events.

    Acquires a concurrency semaphore so at most N downloads run simultaneously.
    The entry stays in "queued" status while waiting for a slot.
    """
    sem = _get_concurrency_semaphore()
    send_event = _get_send_event()

    # Wait for a concurrency slot — entry stays "queued" during this time
    sem.acquire()
    try:
        _download_worker_inner(md5, send_event)
    finally:
        sem.release()


def _download_worker_inner(md5: str, send_event) -> None:
    """Inner download logic, runs after concurrency slot is acquired.

    Delegates the full tracked lifecycle (history records + terminal-state
    guard) to ``download_job.run_download``.  The ``on_status`` sink mirrors
    each emitted payload into the ``DownloadEntry`` (for ``get_all_statuses``)
    and forwards it to the renderer as a ``download_progress`` event.
    """
    with _lock:
        entry = _downloads[md5]
        # Check if cancelled while waiting in queue
        if entry.cancel_flag.is_set():
            entry.status = "cancelled"
            _emit_download_terminal(entry)
            send_event("download_progress", entry.to_dict())
            return
        entry.status = "downloading"
        entry.started_at = time.time()

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
            if payload.get("total_bytes"):
                entry.total_bytes = payload["total_bytes"]
            if payload.get("downloaded_bytes"):
                entry.downloaded_bytes = payload["downloaded_bytes"]
            entry.progress_percent = payload.get("progress_percent", entry.progress_percent)
            _emit_download_terminal(entry)
        send_event("download_progress", payload)

    # Start a progress-polling thread (transport-specific byte progress).
    poll_stop = threading.Event()
    poll_thread = threading.Thread(
        target=_poll_progress,
        args=(md5, out_dir, poll_stop),
        daemon=True,
        name=f"poll-{md5[:8]}",
    )
    poll_thread.start()

    try:
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
            on_status=on_status,
            cancel=entry.cancel_flag,
        )
    finally:
        poll_stop.set()
        poll_thread.join(timeout=5)


def _poll_progress(md5: str, out_dir: str, stop_event: threading.Event) -> None:
    """Poll ``.part`` file size every second and emit download_progress events.

    Total file size is read from a ``.size`` sidecar written by
    ``annas_archive_tool._download_attempt_once`` as soon as the HTTP
    Content-Length header is received.  This allows meaningful percentage
    and ETA display before the download completes.
    """
    send_event = _get_send_event()

    # The tool writes <out_dir>/<md5>.file.part for the in-progress bytes
    # and <out_dir>/<md5>.file.part.size once Content-Length is known.
    part_path = os.path.join(out_dir, f"{md5}.file.part")
    size_path = part_path + _SIZE_SIDECAR_SUFFIX

    while not stop_event.is_set():
        stop_event.wait(timeout=0.5)
        if stop_event.is_set():
            break

        with _lock:
            entry = _downloads.get(md5)
            if entry is None or entry.status not in ("started", "downloading"):
                break

        try:
            # Try to read total_bytes from the sidecar the first time it appears
            if entry.total_bytes == 0 and os.path.exists(size_path):
                try:
                    with open(size_path) as f:
                        val = int(f.read().strip())
                    if val > 0:
                        with _lock:
                            entry.total_bytes = val
                except (OSError, ValueError):
                    pass

            if os.path.exists(part_path):
                current = os.path.getsize(part_path)
                with _lock:
                    entry.downloaded_bytes = current
                    if entry.total_bytes > 0:
                        entry.progress_percent = min((current / entry.total_bytes) * 100, 99.9)
                send_event("download_progress", entry.to_dict())
        except OSError:
            pass

    # One final event after loop ends
    with _lock:
        entry = _downloads.get(md5)
    if entry:
        send_event("download_progress", entry.to_dict())

    # Clean up the size sidecar if it still exists
    try:
        if os.path.exists(size_path):
            os.remove(size_path)
    except OSError:
        pass
