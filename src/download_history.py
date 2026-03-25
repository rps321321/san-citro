"""Download history tracking backed by a local SQLite database."""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .logger import get_logger

logger = get_logger()

# Default database location: sibling to the src/ directory
_DEFAULT_DB_PATH = str(Path(__file__).parent.parent / "download_history.db")


def _connect(db_path: Optional[str] = None) -> sqlite3.Connection:
    """Open a connection with WAL mode for safe concurrent reads."""
    resolved = db_path or _DEFAULT_DB_PATH
    conn = sqlite3.connect(resolved)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.row_factory = sqlite3.Row
    return conn


def init_downloads_table(db_path: Optional[str] = None) -> None:
    """Create the downloads table if it does not already exist."""
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


def record_download_start(
    db_path: Optional[str] = None,
    md5: str = "",
    title: str = "",
) -> None:
    """Insert a new row (or update an existing one) with status='started'."""
    if not md5:
        logger.warning("record_download_start called without an md5 — skipping")
        return

    init_downloads_table(db_path)
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

    init_downloads_table(db_path)
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

    init_downloads_table(db_path)
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


def get_download_history(
    db_path: Optional[str] = None,
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """Return the most recent downloads, newest first."""
    init_downloads_table(db_path)

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


def is_downloaded(db_path: Optional[str] = None, md5: str = "") -> bool:
    """Return True if the given md5 has a completed download record."""
    if not md5:
        return False

    init_downloads_table(db_path)

    with _connect(db_path) as conn:
        cursor = conn.execute(
            "SELECT 1 FROM downloads WHERE md5 = ? AND status = 'completed'",
            (md5,),
        )
        return cursor.fetchone() is not None
