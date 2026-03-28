"""Download history tracking backed by a local SQLite database."""

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .logger import get_logger

logger = get_logger()

# Default database location: sibling to the src/ directory
_DEFAULT_DB_PATH = str(Path(__file__).parent.parent / "download_history.db")

# Lazy-init flag per db_path to avoid redundant CREATE TABLE on every call
_initialized_dbs: set[str] = set()
_init_lock = threading.Lock()


def _connect(db_path: Optional[str] = None) -> sqlite3.Connection:
    """Open a connection with WAL mode and busy timeout for safe concurrent access."""
    resolved = db_path or _DEFAULT_DB_PATH
    conn = sqlite3.connect(resolved, timeout=30)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_table(db_path: Optional[str] = None) -> None:
    """Create the downloads table once per db_path, guarded by a lock."""
    resolved = db_path or _DEFAULT_DB_PATH
    if resolved in _initialized_dbs:
        return
    with _init_lock:
        # Double-check after acquiring the lock
        if resolved in _initialized_dbs:
            return
        with _connect(db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS downloads (
                    md5             TEXT PRIMARY KEY,
                    title           TEXT,
                    filename        TEXT,
                    status          TEXT,
                    started_at      TIMESTAMP,
                    completed_at    TIMESTAMP,
                    filesize_bytes  INTEGER,
                    error           TEXT
                )
            """)
            conn.commit()
        _initialized_dbs.add(resolved)


def init_downloads_table(db_path: Optional[str] = None) -> None:
    """Public entry point kept for backwards compatibility."""
    _ensure_table(db_path)


def cleanup_orphaned_downloads(db_path: Optional[str] = None) -> int:
    """Mark any 'downloading'/'started'/'queued' entries as 'interrupted'.

    Called on app startup to handle downloads that were abandoned when the
    previous session was killed (e.g., Task Manager, power loss). Returns
    the number of rows updated.
    """
    _ensure_table(db_path)
    now = datetime.now(timezone.utc).isoformat()
    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            UPDATE downloads
            SET status = 'interrupted', error = 'App closed during download', completed_at = ?
            WHERE status IN ('downloading', 'started', 'queued')
            """,
            (now,),
        )
        conn.commit()
        count = cursor.rowcount
        if count > 0:
            logger.info("Cleaned up %d orphaned download(s) from previous session", count)
        return count


def record_download_start(
    db_path: Optional[str] = None,
    md5: str = "",
    title: str = "",
) -> None:
    """Insert a new row (or update an existing one) with status='started'."""
    if not md5:
        logger.warning("record_download_start called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(timezone.utc).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO downloads (md5, title, status, started_at)
            VALUES (?, ?, 'started', ?)
            ON CONFLICT(md5) DO UPDATE SET
                title       = excluded.title,
                status      = 'started',
                started_at  = excluded.started_at,
                completed_at = NULL,
                filename    = NULL,
                filesize_bytes = NULL,
                error       = NULL
            """,
            (md5, title, now),
        )
        conn.commit()
    logger.debug(f"Recorded download start for {md5[:8]}")


def record_download_complete(
    db_path: Optional[str] = None,
    md5: str = "",
    filename: str = "",
    filesize_bytes: int = 0,
) -> None:
    """Mark an existing download as completed."""
    if not md5:
        logger.warning("record_download_complete called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(timezone.utc).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE downloads
            SET status         = 'completed',
                completed_at   = ?,
                filename       = ?,
                filesize_bytes = ?
            WHERE md5 = ?
            """,
            (now, filename, filesize_bytes, md5),
        )
        conn.commit()
    logger.debug(f"Recorded download complete for {md5[:8]}")


def record_download_failed(
    db_path: Optional[str] = None,
    md5: str = "",
    error: str = "",
) -> None:
    """Mark an existing download as failed, storing the error message."""
    if not md5:
        logger.warning("record_download_failed called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(timezone.utc).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE downloads
            SET status       = 'failed',
                completed_at = ?,
                error        = ?
            WHERE md5 = ?
            """,
            (now, error, md5),
        )
        conn.commit()
    logger.debug(f"Recorded download failure for {md5[:8]}")


def record_download_cancelled(
    db_path: Optional[str] = None,
    md5: str = "",
) -> None:
    """Mark an existing download as cancelled."""
    if not md5:
        logger.warning("record_download_cancelled called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(timezone.utc).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE downloads
            SET status       = 'cancelled',
                completed_at = ?
            WHERE md5 = ?
            """,
            (now, md5),
        )
        conn.commit()
    logger.debug(f"Recorded download cancelled for {md5[:8]}")


def get_download_history(
    db_path: Optional[str] = None,
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """Return the most recent downloads, newest first."""
    _ensure_table(db_path)

    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            SELECT md5, title, filename, status, started_at,
                   completed_at, filesize_bytes, error
            FROM downloads
            ORDER BY started_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in cursor.fetchall()]


def get_completed_download(
    db_path: Optional[str] = None, md5: str = ""
) -> Optional[Dict[str, Any]]:
    """Return the completed download record for an md5, or None."""
    if not md5:
        return None
    _ensure_table(db_path)
    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            SELECT md5, title, filename, status, started_at,
                   completed_at, filesize_bytes, error
            FROM downloads
            WHERE md5 = ? AND status = 'completed'
            LIMIT 1
            """,
            (md5,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def is_downloaded(db_path: Optional[str] = None, md5: str = "") -> bool:
    """Return True if the given md5 has a completed download record."""
    if not md5:
        return False

    _ensure_table(db_path)

    with _connect(db_path) as conn:
        cursor = conn.execute(
            "SELECT 1 FROM downloads WHERE md5 = ? AND status = 'completed'",
            (md5,),
        )
        return cursor.fetchone() is not None
