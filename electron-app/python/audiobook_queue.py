"""Decoupled audiobook processing queue + spec-sized worker pool (ADR-0009).

Audiobook processing (archive extract -> ffprobe -> chapter build) runs in its
OWN queue and worker pool, NEVER on download slots: a slow extraction must not
block a download. Jobs are enqueued by Category-after-Artifact (classify once
via list_archive / audio extension; only audiobook Artifacts reach here).
``downloads.media_type`` is stamped on that decision path — this queue does
not re-stamp. The processor is authoritative and exception-safe, driving the
``audiobooks`` table status ``pending -> processing -> ready | unsupported |
error`` (separate from download terminal).

Failure is isolated: a processing exception only sets the audiobook status; it
never touches the ``downloads`` row. Workers are daemon threads that NEVER die.
"""

from __future__ import annotations

import os
import queue
import subprocess
import threading

from src import audiobook_db, audiobook_processor
from src.download_history import get_completed_download
from src.logger import get_logger
from src.storage_location import resolve_book_file

logger = get_logger()

# Module-level job queue + worker-pool lazy-init guard.
_job_queue: queue.Queue[tuple[str, str, str]] = queue.Queue()
_pool_lock = threading.Lock()
_pool_started = False

# Pool-size bounds (ADR-0009: extraction is disk-I/O-bound, disk type dominates).
_MAX_POOL = 3
_MIN_POOL = 1


def _get_send_event():  # type: ignore[no-untyped-def]
    """Lazy import to avoid a circular dependency with bridge.py."""
    from bridge import send_event

    return send_event


def _drive_media_type(out_dir: str) -> str:
    """Return 'SSD', 'HDD', or 'UNKNOWN' for the drive backing *out_dir*.

    Windows-only: map the drive letter -> partition -> physical disk MediaType
    via PowerShell. Any failure (non-Windows, no PowerShell, parse error,
    timeout) returns 'UNKNOWN' so the caller falls back to the serial pool.
    """
    try:
        drive = os.path.splitdrive(os.path.abspath(out_dir))[0].rstrip(":")
        if not drive:
            return "UNKNOWN"
        script = f"(Get-Partition -DriveLetter '{drive}' | Get-Disk | Get-PhysicalDisk).MediaType"
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return "UNKNOWN"
        media = result.stdout.strip().upper()
        if "SSD" in media:
            return "SSD"
        if "HDD" in media:
            return "HDD"
        return "UNKNOWN"
    except (OSError, subprocess.SubprocessError, ValueError):
        return "UNKNOWN"


def _compute_pool_size(out_dir: str) -> int:
    """Spec-sized worker count: 1 on HDD/unknown, cores//2 (cap 3) on SSD."""
    cores = os.cpu_count() or 1
    if _drive_media_type(out_dir) == "SSD":
        return max(_MIN_POOL, min(cores // 2, _MAX_POOL))
    return _MIN_POOL


def start(out_dir: str) -> None:
    """Lazily spawn the daemon worker pool once (idempotent)."""
    global _pool_started
    with _pool_lock:
        if _pool_started:
            return
        size = _compute_pool_size(out_dir)
        for i in range(size):
            thread = threading.Thread(
                target=_worker_loop,
                daemon=True,
                name=f"ab-worker-{i}",
            )
            thread.start()
        _pool_started = True
        logger.info("Audiobook queue started with %d worker(s)", size)


def enqueue(md5: str, file_path: str, out_dir: str) -> None:
    """Put a processing job on the queue (starting the pool first if needed)."""
    start(out_dir)
    _job_queue.put((md5, file_path, out_dir))


def _process_one(md5: str, file_path: str, out_dir: str) -> None:
    """Process a single job: extract/chapters + emit status.

    Category (``downloads.media_type``) was already stamped once by
    Category-after-Artifact before enqueue — do not re-classify or re-stamp
    here (avoids a second conflicting rule after process).
    """
    status = audiobook_processor.process_audiobook(md5, file_path, out_dir)
    try:
        _get_send_event()("audiobook_status", {"md5": md5, "status": status})
    except Exception:
        logger.warning("audiobook_status event emit failed for %s", md5[:8], exc_info=True)


def _worker_loop() -> None:
    """Consume jobs forever; a crash in one job never kills the worker."""
    while True:
        md5, file_path, out_dir = _job_queue.get()
        try:
            _process_one(md5, file_path, out_dir)
        except Exception:
            logger.exception("audiobook worker crashed on %s", md5[:8])
        finally:
            _job_queue.task_done()


def resweep(out_dir: str) -> None:
    """Startup recovery: reset stuck rows, sweep stale tmp, re-enqueue pending.

    Resets any ``processing`` row left by a crashed session back to ``pending``,
    deletes orphaned ``<md5>.tmp`` extraction dirs, then re-enqueues every row
    now ``pending`` from its still-on-disk archive — or marks it ``error`` if the
    source archive is gone. Re-extraction is idempotent.
    """
    audiobook_db.reset_stuck_audiobooks()
    audiobook_processor.sweep_stale_tmp(out_dir)
    for row in audiobook_db.list_audiobooks():
        if row.get("status") != "pending":
            continue
        md5 = row["md5"]
        download = get_completed_download(md5=md5)
        filename = download.get("filename") if download else None
        if not filename:
            audiobook_db.set_audiobook_status(md5=md5, status="error", error_message="source archive missing")
            continue
        # Prefer San Citro book path, then legacy flat (no mass-move).
        file_path = resolve_book_file(out_dir, filename)
        if file_path:
            enqueue(md5, file_path, out_dir)
        else:
            audiobook_db.set_audiobook_status(md5=md5, status="error", error_message="source archive missing")
