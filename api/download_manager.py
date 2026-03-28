"""Background download queue manager with SSE broadcast.

Manages a ThreadPoolExecutor for concurrent downloads and provides
real-time status updates via Server-Sent Events.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, Future
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

from .models import DownloadStatus, DownloadStatusEnum

logger = logging.getLogger("annas_archive")

# Patterns for sanitizing error messages before exposing to clients
_ABS_PATH_RE = re.compile(r'[A-Za-z]:\\[\w\\.\-/ ]+|/(?:home|tmp|var|usr|etc|opt|mnt|root)[\w/.\-]*')
_PROXY_URL_RE = re.compile(r'(https?|socks[45]h?)://[^\s,;)\"\']+', re.IGNORECASE)


def _sanitize_error(msg: str) -> str:
    """Strip filesystem paths and proxy/internal URLs from an error message."""
    msg = _ABS_PATH_RE.sub('<path>', msg)
    msg = _PROXY_URL_RE.sub('<redacted-url>', msg)
    return msg


class DownloadManager:
    """Manages background download jobs with status tracking and SSE broadcast.

    Usage:
        manager = DownloadManager(config)
        manager.start()
        status = manager.enqueue("abc123...", "My Book")
        async for event in manager.subscribe():
            print(event)
        manager.shutdown()
    """

    # How long (seconds) to keep terminal jobs before evicting from _jobs
    _JOB_RETENTION_SECS = 300  # 5 minutes

    def __init__(self, config: dict) -> None:
        self._config = config
        self._executor: Optional[ThreadPoolExecutor] = None
        self._jobs: dict[str, DownloadStatus] = {}
        self._futures: dict[str, Future] = {}
        self._subscribers: list[asyncio.Queue[DownloadStatus]] = []
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        # Tracks terminal jobs pending eviction: md5 -> monotonic deadline
        self._eviction_deadlines: dict[str, float] = {}

    def start(self) -> None:
        """Initialize the thread pool executor.

        Must be called from the asyncio event loop thread so we can
        capture the loop reference for thread-safe queue operations.
        """
        self._loop = asyncio.get_running_loop()
        concurrency = max(1, self._config.get("concurrency", 2))
        self._executor = ThreadPoolExecutor(
            max_workers=concurrency,
            thread_name_prefix="download",
        )
        logger.info(f"DownloadManager started with concurrency={concurrency}")

    def shutdown(self) -> None:
        """Shut down the executor, cancelling pending futures."""
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
        logger.info("DownloadManager shut down")

    def enqueue(self, md5: str, title: str = "") -> DownloadStatus:
        """Enqueue a download job and return its initial status.

        If a job for the same md5 is already running or queued, returns
        the existing status instead of creating a duplicate.
        """
        with self._lock:
            if md5 in self._jobs:
                existing = self._jobs[md5]
                if existing.status in (
                    DownloadStatusEnum.queued,
                    DownloadStatusEnum.started,
                    DownloadStatusEnum.downloading,
                ):
                    return existing

            status = DownloadStatus(
                md5=md5,
                title=title,
                status=DownloadStatusEnum.queued,
                started_at=datetime.now(timezone.utc),
            )
            self._jobs[md5] = status
            self._broadcast_sync(status)

            if self._executor is None:
                self.start()

            future = self._executor.submit(self._run_download, md5, title)  # type: ignore[union-attr]
            self._futures[md5] = future
            return status

    def get_status(self, md5: str) -> Optional[DownloadStatus]:
        """Get the status of a specific download job."""
        return self._jobs.get(md5)

    def get_all_statuses(self) -> list[DownloadStatus]:
        """Return all tracked download statuses (active and recent)."""
        with self._lock:
            return list(self._jobs.values())

    def cancel(self, md5: str) -> bool:
        """Cancel a queued or running download.

        Returns True if the job was found and cancellation was attempted.
        """
        with self._lock:
            if md5 not in self._jobs:
                return False

            future = self._futures.get(md5)
            if future is not None:
                future.cancel()

            self._update_status_locked(
                md5,
                status=DownloadStatusEnum.cancelled,
                error="Cancelled by user",
            )

        # Persist cancellation to download history outside the lock to avoid
        # holding it during DB I/O.
        try:
            from src.config_manager import get_config
            from src.download_history import record_download_cancelled

            config = get_config()
            history_db = config.get("history_db")
            record_download_cancelled(db_path=history_db, md5=md5)
        except Exception as exc:
            logger.error(f"[{md5[:8]}] Failed to persist cancellation to history: {exc}")

        return True

    async def subscribe(self) -> AsyncGenerator[DownloadStatus, None]:
        """Yield download status events as they occur.

        Each subscriber gets their own asyncio.Queue so events are
        independently consumed without blocking other subscribers.
        """
        queue: asyncio.Queue[DownloadStatus] = asyncio.Queue(maxsize=100)
        with self._lock:
            self._subscribers.append(queue)
        try:
            while True:
                event = await queue.get()
                yield event
        except asyncio.CancelledError:
            pass
        finally:
            with self._lock:
                self._subscribers.remove(queue)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _run_download(self, md5: str, title: str) -> None:
        """Execute a single download in a worker thread.

        This is the function submitted to the ThreadPoolExecutor.
        """
        from src.config_manager import get_config
        from src.annas_archive_tool import AnnasArchiveTool
        from src.download_history import (
            record_download_start,
            record_download_complete,
            record_download_failed,
        )

        config = get_config()
        out_dir = config.get("out_dir", "downloads")
        history_db = config.get("history_db")
        proxies = config.get("proxies", [])

        self._update_status(md5, status=DownloadStatusEnum.started)
        record_download_start(db_path=history_db, md5=md5, title=title)

        try:
            with AnnasArchiveTool(proxies=proxies) as tool:
                self._update_status(md5, status=DownloadStatusEnum.downloading)

                result_path = tool.automated_slow_download(md5, output_dir=out_dir)

            if result_path:
                filesize = (
                    os.path.getsize(result_path)
                    if os.path.exists(result_path)
                    else 0
                )
                filename = os.path.basename(result_path)
                record_download_complete(
                    db_path=history_db,
                    md5=md5,
                    filename=filename,
                    filesize_bytes=filesize,
                )
                self._update_status(
                    md5,
                    status=DownloadStatusEnum.completed,
                    progress_percent=100.0,
                    filename=filename,
                )
            else:
                error_msg = "Download returned no file"
                record_download_failed(
                    db_path=history_db, md5=md5, error=error_msg
                )
                self._update_status(
                    md5,
                    status=DownloadStatusEnum.failed,
                    error=error_msg,
                )
        except Exception as exc:
            error_msg = _sanitize_error(str(exc)[:500])
            record_download_failed(
                db_path=history_db, md5=md5, error=error_msg
            )
            self._update_status(
                md5,
                status=DownloadStatusEnum.failed,
                error=error_msg,
            )
            logger.error(f"[{md5[:8]}] Download failed: {exc}")

    def _update_status(
        self,
        md5: str,
        *,
        status: Optional[DownloadStatusEnum] = None,
        progress_percent: Optional[float] = None,
        error: Optional[str] = None,
        filename: Optional[str] = None,
    ) -> None:
        """Update the status of a job and broadcast to subscribers.

        Acquires the lock internally -- do NOT call while holding
        ``self._lock``.  Use ``_update_status_locked`` instead.
        """
        with self._lock:
            self._update_status_locked(
                md5,
                status=status,
                progress_percent=progress_percent,
                error=error,
                filename=filename,
            )

    def _update_status_locked(
        self,
        md5: str,
        *,
        status: Optional[DownloadStatusEnum] = None,
        progress_percent: Optional[float] = None,
        error: Optional[str] = None,
        filename: Optional[str] = None,
    ) -> None:
        """Update job status while the caller already holds ``self._lock``."""
        job = self._jobs.get(md5)
        if job is None:
            return

        if status is not None:
            job.status = status
        if progress_percent is not None:
            job.progress_percent = progress_percent
        if error is not None:
            job.error = error
        if filename is not None:
            job.filename = filename

        # P1: clean up completed futures on terminal states
        _terminal = (
            DownloadStatusEnum.completed,
            DownloadStatusEnum.failed,
            DownloadStatusEnum.cancelled,
        )
        if job.status in _terminal:
            self._futures.pop(md5, None)
            # M5: schedule eviction so _jobs does not grow without bound
            self._eviction_deadlines[md5] = time.monotonic() + self._JOB_RETENTION_SECS

        # Sweep any jobs past their eviction deadline
        self._sweep_expired_jobs()

        self._broadcast_sync(job)

    def _sweep_expired_jobs(self) -> None:
        """Remove terminal jobs that have exceeded their retention period.

        Must be called while ``self._lock`` is held.
        """
        now = time.monotonic()
        expired = [
            md5
            for md5, deadline in self._eviction_deadlines.items()
            if now >= deadline
        ]
        for md5 in expired:
            self._jobs.pop(md5, None)
            self._futures.pop(md5, None)
            self._eviction_deadlines.pop(md5, None)
        if expired:
            logger.debug(f"Evicted {len(expired)} terminal job(s) from _jobs")

    def _broadcast_sync(self, status: DownloadStatus) -> None:
        """Push a status event to all subscriber queues (thread-safe).

        ``asyncio.Queue`` is not thread-safe, so we schedule the
        ``put_nowait`` calls on the event loop via
        ``loop.call_soon_threadsafe`` when called from a worker thread.
        Must be called while ``self._lock`` is held so the subscriber
        snapshot is consistent.
        """
        # Snapshot to avoid iterating a list that may mutate
        subscribers = list(self._subscribers)
        loop = self._loop

        for queue in subscribers:
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(self._enqueue_event, queue, status)
            else:
                # Fallback for calls made directly on the event loop thread
                # before the loop is running (e.g. during startup).
                self._enqueue_event(queue, status)

    @staticmethod
    def _enqueue_event(
        queue: asyncio.Queue[DownloadStatus], status: DownloadStatus
    ) -> None:
        """Put an event into a subscriber queue, dropping oldest on overflow."""
        try:
            queue.put_nowait(status)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
                queue.put_nowait(status)
            except asyncio.QueueEmpty:
                pass
