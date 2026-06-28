"""Backend-agnostic download lifecycle for a single book.

Owns the canonical terminal-state machine (C2): a job whose cancel token is
set may ONLY land in ``cancelled`` — never ``completed`` / ``failed``. Both the
CLI and the Electron bridge delegate to :func:`run_download`, which drives the
status transitions, records history, and emits the shared ``on_status`` payload.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from .annas_archive_tool import AnnasArchiveTool
from .config_manager import get_config
from .download_history import (
    record_download_cancelled,
    record_download_complete,
    record_download_failed,
    record_download_start,
)

if TYPE_CHECKING:
    import threading

    from .download_strategy import DownloadStrategy

# Retention constant lifted here (single source of truth, was duplicated in
# download_manager).
TERMINAL_RETENTION_S: float = 300.0

# Terminal statuses (importable by callers for pruning/guards).
TERMINAL_STATES: frozenset[str] = frozenset({"completed", "failed", "cancelled", "interrupted"})

StatusSink = Callable[[dict[str, Any]], None]  # receives the §0 payload dict


def run_download(
    md5: str,
    title: str,
    out_dir: str,
    history_db: str | None,
    strategy: DownloadStrategy,
    on_status: StatusSink,
    cancel: threading.Event,
    proxies: list[str] | None = None,
    meta: dict[str, Any] | None = None,
) -> str | None:
    """Full tracked download lifecycle for ONE book. Returns the final file
    path on success, else None. Never raises for normal download failure —
    converts exceptions to a 'failed' terminal status + on_status emit, and
    returns None. Re-raises nothing to the caller.
    """
    status: dict[str, Any] = {
        "md5": md5,
        "title": title,
        "status": "queued",
        "progress_percent": 0.0,
        "total_bytes": 0,
        "downloaded_bytes": 0,
        "error": None,
        "filename": None,
        "file_path": None,
        "started_at": time.time(),
    }

    def emit(new_status: str) -> None:
        status["status"] = new_status
        status["progress_percent"] = round(float(status["progress_percent"]), 1)
        on_status(dict(status))

    # --- Pre-flight cancel check ---
    if cancel.is_set():
        record_download_cancelled(db_path=history_db, md5=md5)
        emit("cancelled")
        return None

    record_download_start(db_path=history_db, md5=md5, title=title, meta=meta)
    emit("started")
    emit("downloading")

    # An explicit proxies list (incl. an empty one, e.g. CLI --direct) overrides
    # the config; None means "read config" so existing callers are unchanged.
    tool_proxies = proxies if proxies is not None else get_config().get("proxies")

    result_path: str | None = None
    try:
        with AnnasArchiveTool(proxies=tool_proxies, strategy=strategy) as tool:
            result_path = tool.automated_slow_download(md5=md5, output_dir=out_dir, cancel=cancel)
    except Exception as exc:
        if cancel.is_set():
            record_download_cancelled(db_path=history_db, md5=md5)
            emit("cancelled")
            return None
        status["error"] = str(exc)[:500]
        record_download_failed(db_path=history_db, md5=md5, error=status["error"])
        emit("failed")
        return None

    # --- Terminal-state guard (C2 canonical) ---
    if cancel.is_set():
        record_download_cancelled(db_path=history_db, md5=md5)
        emit("cancelled")
        return None

    if result_path:
        abs_path = os.path.abspath(result_path)
        filesize = os.path.getsize(abs_path) if os.path.exists(abs_path) else 0
        status["file_path"] = abs_path
        status["filename"] = os.path.basename(abs_path)
        status["total_bytes"] = filesize
        status["downloaded_bytes"] = filesize
        status["progress_percent"] = 100.0
        record_download_complete(
            db_path=history_db,
            md5=md5,
            filename=status["filename"],
            filesize_bytes=filesize,
        )
        emit("completed")
        return abs_path

    status["error"] = "Download returned no file (strategies exhausted or MD5 mismatch)"
    record_download_failed(db_path=history_db, md5=md5, error=status["error"])
    emit("failed")
    return None
