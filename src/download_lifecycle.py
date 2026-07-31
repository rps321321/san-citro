"""Single-job Download lifecycle (shared by CLI and Electron bridge).

Owns the canonical terminal-state machine: a job whose cancel token is set
may ONLY land in ``cancelled`` — never ``completed`` / ``failed``. Both the
CLI and the Electron bridge delegate to :func:`run_download`, which drives
status transitions, records history, and emits the shared ``on_status`` payload.

Public live status vocabulary (glossary):
``queued → downloading → completed | failed | cancelled``.
History may still store internal start rows (status ``started``) without
leaking that as a public live status.

Terminal event (glossary): exactly one ``download_analytics`` fact is built
at a terminal state and delivered through the optional ``on_terminal_fact``
sink. CLI passes no sink (no-op); the bridge wires it to the telemetry emitter.
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
from .storage_location import book_download_dir

if TYPE_CHECKING:
    import threading

    from .download_strategy import DownloadStrategy

# Retention constant (single source of truth for live UI prune).
TERMINAL_RETENTION_S: float = 300.0

# Terminal statuses (importable by callers for pruning/guards).
# ``interrupted`` is history-only (orphan cleanup), not a live public status.
TERMINAL_STATES: frozenset[str] = frozenset({"completed", "failed", "cancelled", "interrupted"})

# Public live statuses only (no ``started``).
PUBLIC_STATUSES: frozenset[str] = frozenset(
    {"queued", "downloading", "completed", "failed", "cancelled"}
)

# Durable / history-only values → public Download lifecycle alphabet.
# Sole backend coercion table; keep in sync with web/src/lib/status.ts.
# ``interrupted`` is intentionally absent: history-only, not a live public status.
_DURABLE_TO_PUBLIC: dict[str, str] = {
    "started": "downloading",
}


def normalize_download_status(status: str) -> str:
    """Map durable/history statuses onto the public Download lifecycle alphabet.

    Public values (``queued|downloading|completed|failed|cancelled``) are
    identity. History-only ``started`` becomes ``downloading``. ``interrupted``
    and unknown values pass through unchanged so callers can keep raw durable
    rows internal and only coerce at display / live projection seams.
    """
    return _DURABLE_TO_PUBLIC.get(status, status)


# Live terminal outcomes that produce a Terminal event fact.
_TERMINAL_FACT_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled"})

StatusSink = Callable[[dict[str, Any]], None]  # receives the status payload dict
ProgressSink = Callable[[int, int], None]  # (downloaded_bytes, total_bytes)
TerminalFactSink = Callable[[dict[str, Any]], None]  # download_analytics fact dict
# Category-after-Artifact hook: (md5, abs_file_path, out_dir). Bridge wires
# classify + media_type stamp + audiobook enqueue; CLI omits (no-op).
CompletedHook = Callable[[str, str, str], None]

# Injectible transport for tests / callers that already own a tool session.
# Signature: (md5, out_dir, cancel, on_progress) -> path | None
DownloadFn = Callable[
    [str, str, "threading.Event | None", ProgressSink | None],
    str | None,
]

# Map known strategy classes to stable transport labels (not permanent placeholders).
_STRATEGY_LABELS: dict[str, str] = {
    "ChromeStrategy": "chrome",
    "DirectHTTPStrategy": "direct",
}


def strategy_label(strategy: Any) -> str | None:
    """Stable strategy name when known; None for mocks / unknown types."""
    if strategy is None:
        return None
    cls_name = type(strategy).__name__
    if cls_name in _STRATEGY_LABELS:
        return _STRATEGY_LABELS[cls_name]
    name = getattr(strategy, "name", None)
    if isinstance(name, str) and name:
        return name
    return None


def build_terminal_fact(
    *,
    md5: str,
    title: str,
    status: str,
    started_at: float | None,
    file_path: str | None = None,
    total_bytes: int = 0,
    error: str | None = None,
    strategy: str | None = None,
    mirror_domain: str | None = None,
    proxy_used: bool | None = None,
    ended_at: float | None = None,
) -> dict[str, Any]:
    """Build the download_analytics Terminal event fact (one shape, all callers).

    Includes outcome fields (status, timing, size, speed, error) and transport
    fields when known (strategy, mirror_domain, proxy_used). Unknown transport
    facts stay ``None`` rather than hardcoded placeholders.
    """
    name = os.path.basename(file_path) if file_path else None
    ext = os.path.splitext(name)[1].lstrip(".").lower() if name else None
    file_size_bytes = int(total_bytes) if total_bytes else None
    end = ended_at if ended_at is not None else time.time()
    duration_seconds = round(end - started_at, 1) if started_at is not None else None
    avg_speed_bps = (
        round(file_size_bytes / duration_seconds)
        if duration_seconds and file_size_bytes and duration_seconds > 0
        else None
    )
    return {
        "md5": md5,
        "title": title,
        "extension": ext or None,
        "status": status,
        "file_size_bytes": file_size_bytes,
        "duration_seconds": duration_seconds,
        "avg_speed_bps": avg_speed_bps,
        "mirror_domain": mirror_domain,
        "strategy": strategy,
        "proxy_used": proxy_used,
        "error_message": error,
    }


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
    on_progress: ProgressSink | None = None,
    download_fn: DownloadFn | None = None,
    on_terminal_fact: TerminalFactSink | None = None,
    on_completed: CompletedHook | None = None,
) -> str | None:
    """Full tracked download lifecycle for ONE book.

    Returns the final file path on success, else None. Never raises for normal
    download failure — converts exceptions to a ``failed`` terminal status +
    on_status emit, and returns None.

    ``download_fn``, when provided, is the transport (used by tests with a fake
    and by the CLI to reuse an existing tool session so it does not
    double-construct ``AnnasArchiveTool``). When omitted, a tool is created
    from ``strategy`` / ``proxies`` for this job only.

    ``on_terminal_fact``, when provided, receives exactly one Terminal event
    fact at the first terminal status (completed | failed | cancelled). CLI
    omits it (no-op); the bridge wires it to the telemetry emitter.

    ``on_completed``, when provided, is invoked once after a successful
    completion (Artifact path ready, history completed, public status
    ``completed`` delivered). Intended for Category-after-Artifact (classify +
    stamp + enqueue). Exceptions from the hook are swallowed so Category
    failures never corrupt the completed download.
    """
    started_at = time.time()
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
        "started_at": started_at,
    }

    # An explicit proxies list (incl. an empty one, e.g. CLI --direct) overrides
    # the config; None means "read config" so existing callers are unchanged.
    tool_proxies = proxies if proxies is not None else get_config().get("proxies")
    proxy_used = bool(tool_proxies)
    known_strategy = strategy_label(strategy)

    terminal_fact_emitted = False

    def emit(new_status: str) -> None:
        status["status"] = new_status
        status["progress_percent"] = round(float(status["progress_percent"]), 1)
        on_status(dict(status))

    def deliver_terminal(new_status: str) -> None:
        """Emit public status and deliver Terminal event fact at most once."""
        nonlocal terminal_fact_emitted
        emit(new_status)
        if on_terminal_fact is None or terminal_fact_emitted:
            return
        if new_status not in _TERMINAL_FACT_STATUSES:
            return
        terminal_fact_emitted = True
        fact = build_terminal_fact(
            md5=md5,
            title=title,
            status=new_status,
            started_at=started_at,
            file_path=status.get("file_path"),
            total_bytes=int(status.get("total_bytes") or 0),
            error=status.get("error"),
            strategy=known_strategy,
            mirror_domain=None,  # transport does not surface mirror yet
            proxy_used=proxy_used,
        )
        try:
            on_terminal_fact(fact)
        except Exception:
            # Terminal sink must never break the download (telemetry is best-effort).
            pass

    def report_progress(downloaded: int, total: int) -> None:
        """Transport progress → status fields + optional external sink."""
        status["downloaded_bytes"] = int(downloaded)
        if total and total > 0:
            status["total_bytes"] = int(total)
            status["progress_percent"] = min((downloaded / total) * 100.0, 99.9)
        if on_progress is not None:
            on_progress(int(downloaded), int(total or 0))
        # Keep public stream on ``downloading`` while bytes move (no ``started``).
        if status["status"] in ("queued", "downloading"):
            emit("downloading")

    # --- Pre-flight cancel check ---
    if cancel.is_set():
        record_download_cancelled(db_path=history_db, md5=md5)
        deliver_terminal("cancelled")
        return None

    # History start row (internal status ``started``) + Metadata spine.
    record_download_start(db_path=history_db, md5=md5, title=title, meta=meta)
    emit("downloading")

    # New book Artifacts land under San Citro/; config out_dir stays the root
    # for resolve, Category hooks, and audiobook packs (ADR-0006).
    write_dir = book_download_dir(out_dir)

    result_path: str | None = None
    try:
        if download_fn is not None:
            result_path = download_fn(md5, write_dir, cancel, report_progress)
        else:
            with AnnasArchiveTool(
                proxies=tool_proxies,
                strategy=strategy,
                on_progress=report_progress,
            ) as tool:
                result_path = tool.automated_slow_download(
                    md5=md5, output_dir=write_dir, cancel=cancel
                )
    except Exception as exc:
        if cancel.is_set():
            record_download_cancelled(db_path=history_db, md5=md5)
            deliver_terminal("cancelled")
            return None
        status["error"] = str(exc)[:500]
        record_download_failed(db_path=history_db, md5=md5, error=status["error"])
        deliver_terminal("failed")
        return None

    # --- Terminal-state guard (C2 canonical) ---
    if cancel.is_set():
        record_download_cancelled(db_path=history_db, md5=md5)
        deliver_terminal("cancelled")
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
        # Terminal download first (bytes done). Category/processing is separate.
        deliver_terminal("completed")
        if on_completed is not None:
            try:
                on_completed(md5, abs_path, out_dir)
            except Exception:
                # Category/enqueue must never un-complete a successful download.
                pass
        return abs_path

    status["error"] = "Download returned no file (strategies exhausted or MD5 mismatch)"
    record_download_failed(db_path=history_db, md5=md5, error=status["error"])
    deliver_terminal("failed")
    return None
