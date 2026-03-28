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
from typing import Any, Optional

# Sidecar file written by annas_archive_tool when Content-Length is known.
# Format: plain integer (bytes) on a single line.
_SIZE_SIDECAR_SUFFIX = ".size"

from src.annas_archive_tool import AnnasArchiveTool
from src.config_manager import get_config
from src.download_history import (
    record_download_cancelled,
    record_download_complete,
    record_download_failed,
    record_download_start,
)

logger = logging.getLogger("bridge.download_manager")


@dataclass
class DownloadEntry:
    """Mutable state for a single in-flight download."""

    md5: str
    title: str
    status: str = "queued"          # queued | downloading | completed | failed | cancelled
    progress_percent: float = 0.0   # 0..100
    total_bytes: int = 0
    downloaded_bytes: int = 0
    error: Optional[str] = None
    cancel_flag: threading.Event = field(default_factory=threading.Event)
    file_path: Optional[str] = None
    started_at: Optional[float] = None  # unix timestamp

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
        limit = max(1, min(32, config.get("concurrency", 2)))
        _concurrency_sem = threading.Semaphore(limit)
    return _concurrency_sem


def _get_send_event():
    """Lazy import to avoid circular dependency with bridge.py."""
    from bridge import send_event
    return send_event


_TERMINAL_RETENTION_S = 300.0  # Auto-prune terminal entries after 5 minutes


def _prune_terminal() -> None:
    """Remove completed/failed/cancelled entries older than retention period.

    Called inside _lock from enqueue() to prevent unbounded dict growth.
    """
    now = time.time()
    stale = [
        md5 for md5, e in _downloads.items()
        if e.status in ("completed", "failed", "cancelled")
        and e.started_at is not None
        and (now - e.started_at) > _TERMINAL_RETENTION_S
    ]
    for md5 in stale:
        del _downloads[md5]


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
    """Inner download logic, runs after concurrency slot is acquired."""
    with _lock:
        entry = _downloads[md5]
        # Check if cancelled while waiting in queue
        if entry.cancel_flag.is_set():
            entry.status = "cancelled"
            send_event("download_progress", entry.to_dict())
            return
        entry.status = "downloading"
        entry.started_at = time.time()

    send_event("download_progress", entry.to_dict())

    config = get_config()
    out_dir = config.get("out_dir", "downloads")
    history_db = config.get("history_db")

    record_download_start(db_path=history_db, md5=md5, title=entry.title)

    # Start a progress-polling thread
    poll_stop = threading.Event()
    poll_thread = threading.Thread(
        target=_poll_progress,
        args=(md5, out_dir, poll_stop),
        daemon=True,
        name=f"poll-{md5[:8]}",
    )
    poll_thread.start()

    result_path: Optional[str] = None
    try:
        tool = AnnasArchiveTool(
            proxies=config.get("proxies"),
            strategy=None,  # use default ChromeStrategy
        )
        with tool:
            result_path = tool.automated_slow_download(md5=md5, output_dir=out_dir)
    except Exception as exc:
        logger.exception("Download failed for %s", md5)
        with _lock:
            entry.status = "failed"
            entry.error = str(exc)
        record_download_failed(db_path=history_db, md5=md5, error=str(exc))
        send_event("download_progress", entry.to_dict())
        return
    finally:
        poll_stop.set()
        poll_thread.join(timeout=5)

    if entry.cancel_flag.is_set():
        with _lock:
            entry.status = "cancelled"
        send_event("download_progress", entry.to_dict())
        return

    if result_path:
        file_size = os.path.getsize(result_path) if os.path.exists(result_path) else 0
        with _lock:
            entry.status = "completed"
            entry.progress_percent = 100.0
            entry.file_path = result_path
            entry.downloaded_bytes = file_size
            entry.total_bytes = file_size
        record_download_complete(
            db_path=history_db,
            md5=md5,
            filename=os.path.basename(result_path),
            filesize_bytes=file_size,
        )
        # Use "download_progress" so the IPC handler forwards it to the renderer.
        # The frontend checks dl.status === "completed" to know it's done.
        send_event("download_progress", entry.to_dict())
    else:
        with _lock:
            entry.status = "failed"
            entry.error = "Download returned no file (strategies exhausted or MD5 mismatch)"
        record_download_failed(db_path=history_db, md5=md5, error=entry.error or "")
        send_event("download_progress", entry.to_dict())


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
        stop_event.wait(timeout=1)
        if stop_event.is_set():
            break

        with _lock:
            entry = _downloads.get(md5)
            if entry is None or entry.status not in ("downloading",):
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
                        entry.progress_percent = min(
                            (current / entry.total_bytes) * 100, 99.9
                        )
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
