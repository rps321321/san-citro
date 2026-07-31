"""Compatibility re-exports for the Download lifecycle module.

Prefer :mod:`src.download_lifecycle` for new code. This module remains so
existing imports (``from src.download_job import run_download``) keep working.
"""

from .download_lifecycle import (
    PUBLIC_STATUSES,
    TERMINAL_RETENTION_S,
    TERMINAL_STATES,
    DownloadFn,
    ProgressSink,
    StatusSink,
    TerminalFactSink,
    build_terminal_fact,
    normalize_download_status,
    run_download,
    strategy_label,
)

__all__ = [
    "PUBLIC_STATUSES",
    "TERMINAL_RETENTION_S",
    "TERMINAL_STATES",
    "DownloadFn",
    "ProgressSink",
    "StatusSink",
    "TerminalFactSink",
    "build_terminal_fact",
    "normalize_download_status",
    "run_download",
    "strategy_label",
]
