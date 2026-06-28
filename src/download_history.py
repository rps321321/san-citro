"""Download history tracking backed by a local SQLite database."""

import sqlite3
import threading
from datetime import UTC, datetime
from typing import Any

from .config_manager import get_default_history_db_path
from .logger import get_logger

logger = get_logger()

# Lazy-init flag per db_path to avoid redundant CREATE TABLE on every call
_initialized_dbs: set[str] = set()
_init_lock = threading.Lock()

# Nullable metadata columns added by a guarded migration (name -> SQLite type).
_META_COLUMNS: dict[str, str] = {
    "author": "TEXT",
    "year": "INTEGER",
    "extension": "TEXT",
    "content_type": "TEXT",
    "language": "TEXT",
    "publisher": "TEXT",
    "cover_url": "TEXT",
    "media_type": "TEXT",
}


def _resolve_db_path(db_path: str | None) -> str:
    """Resolve a db path, falling back to the platform data dir."""
    return db_path or get_default_history_db_path()


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    """Open a connection with WAL mode and busy timeout for safe concurrent access."""
    resolved = _resolve_db_path(db_path)
    conn = sqlite3.connect(resolved, timeout=30)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_table(db_path: str | None = None) -> None:
    """Create the downloads table once per db_path, guarded by a lock."""
    resolved = _resolve_db_path(db_path)
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
            _migrate_meta_columns(conn)
            conn.commit()
        _initialized_dbs.add(resolved)


def _migrate_meta_columns(conn: sqlite3.Connection) -> None:
    """Add any missing nullable metadata columns. Idempotent every launch.

    ``ALTER TABLE ADD COLUMN`` is not idempotent on its own, so we read the
    existing columns via ``PRAGMA table_info`` and only add the missing ones.
    """
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(downloads)")}
    for name, col_type in _META_COLUMNS.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE downloads ADD COLUMN {name} {col_type}")


def init_downloads_table(db_path: str | None = None) -> None:
    """Public entry point kept for backwards compatibility."""
    _ensure_table(db_path)


def cleanup_orphaned_downloads(db_path: str | None = None) -> int:
    """Mark any 'downloading'/'started'/'queued' entries as 'interrupted'.

    Called on app startup to handle downloads that were abandoned when the
    previous session was killed (e.g., Task Manager, power loss). Returns
    the number of rows updated.
    """
    _ensure_table(db_path)
    now = datetime.now(UTC).isoformat()
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
    db_path: str | None = None,
    md5: str = "",
    title: str = "",
    meta: dict[str, Any] | None = None,
) -> None:
    """Insert a new row (or update an existing one) with status='started'.

    ``meta`` may carry any of the nullable metadata fields (author, year,
    extension, content_type, language, publisher, cover_url). Only keys that
    are present and non-None are persisted; everything else is left untouched.
    """
    if not md5:
        logger.warning("record_download_start called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(UTC).isoformat()

    # Only persist known meta columns that are present and non-None.
    meta = meta or {}
    extra_cols = [name for name in _META_COLUMNS if meta.get(name) is not None]

    insert_cols = ["md5", "title", "status", "started_at", *extra_cols]
    placeholders = ["?", "?", "'started'", "?", *["?"] * len(extra_cols)]
    insert_values: list[Any] = [md5, title, now, *(meta[name] for name in extra_cols)]

    conflict_updates = [
        "title          = excluded.title",
        "status         = 'started'",
        "started_at     = excluded.started_at",
        "completed_at   = CASE WHEN downloads.status = 'completed' THEN downloads.completed_at   ELSE NULL END",
        "filename       = CASE WHEN downloads.status = 'completed' THEN downloads.filename       ELSE NULL END",
        "filesize_bytes = CASE WHEN downloads.status = 'completed' THEN downloads.filesize_bytes ELSE NULL END",
        "error          = NULL",
        *[f"{name} = excluded.{name}" for name in extra_cols],
    ]

    updates_sql = ",\n    ".join(conflict_updates)
    sql = (
        f"INSERT INTO downloads ({', '.join(insert_cols)})\n"
        f"VALUES ({', '.join(placeholders)})\n"
        f"ON CONFLICT(md5) DO UPDATE SET\n    {updates_sql}"
    )

    with _connect(db_path) as conn:
        conn.execute(sql, insert_values)
        conn.commit()
    logger.debug(f"Recorded download start for {md5[:8]}")


def record_download_complete(
    db_path: str | None = None,
    md5: str = "",
    filename: str = "",
    filesize_bytes: int = 0,
) -> None:
    """Mark an existing download as completed."""
    if not md5:
        logger.warning("record_download_complete called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(UTC).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE downloads
            SET status         = 'completed',
                completed_at   = ?,
                filename       = ?,
                filesize_bytes = ?
            WHERE md5 = ? AND status != 'cancelled'
            """,
            (now, filename, filesize_bytes, md5),
        )
        conn.commit()
    logger.debug(f"Recorded download complete for {md5[:8]}")


def record_download_failed(
    db_path: str | None = None,
    md5: str = "",
    error: str = "",
) -> None:
    """Mark an existing download as failed, storing the error message."""
    if not md5:
        logger.warning("record_download_failed called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(UTC).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE downloads
            SET status       = 'failed',
                completed_at = ?,
                error        = ?
            WHERE md5 = ? AND status != 'cancelled'
            """,
            (now, error, md5),
        )
        conn.commit()
    logger.debug(f"Recorded download failure for {md5[:8]}")


def record_download_cancelled(
    db_path: str | None = None,
    md5: str = "",
) -> None:
    """Mark an existing download as cancelled."""
    if not md5:
        logger.warning("record_download_cancelled called without an md5 — skipping")
        return

    _ensure_table(db_path)
    now = datetime.now(UTC).isoformat()

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
    db_path: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
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


def get_completed_download(db_path: str | None = None, md5: str = "") -> dict[str, Any] | None:
    """Return the completed download record for an md5, or None."""
    if not md5:
        return None
    _ensure_table(db_path)
    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            SELECT md5, title, filename, status, started_at,
                   completed_at, filesize_bytes, error, cover_url
            FROM downloads
            WHERE md5 = ? AND status = 'completed'
            LIMIT 1
            """,
            (md5,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def is_downloaded(db_path: str | None = None, md5: str = "") -> bool:
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


def get_completed_md5s(db_path: str | None = None, md5s: list[str] | None = None) -> set[str]:
    """Return the subset of ``md5s`` that have a completed download record.

    One query for the whole batch — lets search results be flagged as already
    downloaded without an N+1 round-trip per result.
    """
    md5_list = [m for m in (md5s or []) if m]
    if not md5_list:
        return set()
    _ensure_table(db_path)
    placeholders = ",".join("?" for _ in md5_list)
    with _connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT md5 FROM downloads WHERE status = 'completed' AND md5 IN ({placeholders})",
            md5_list,
        ).fetchall()
    return {row["md5"] for row in rows}


def list_library(db_path: str | None = None) -> list[dict[str, Any]]:
    """Return all completed downloads with full metadata, newest first."""
    _ensure_table(db_path)
    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            SELECT md5, title, filename, author, year, extension,
                   content_type, language, publisher, cover_url,
                   filesize_bytes, completed_at
            FROM downloads
            WHERE status = 'completed'
            ORDER BY completed_at DESC
            """
        )
        return [dict(row) for row in cursor.fetchall()]


def get_download_stats(db_path: str | None = None) -> dict[str, Any]:
    """Return aggregate download stats. Never raises on an empty/new DB."""
    _ensure_table(db_path)

    with _connect(db_path) as conn:
        counts = conn.execute("SELECT status, COUNT(*) AS n FROM downloads GROUP BY status").fetchall()
        total_size = conn.execute(
            "SELECT COALESCE(SUM(filesize_bytes), 0) FROM downloads WHERE status = 'completed'"
        ).fetchone()[0]

    downloads_by_status: dict[str, int] = {}
    total_downloads = 0
    for row in counts:
        status = row["status"] if row["status"] is not None else "unknown"
        downloads_by_status[status] = row["n"]
        total_downloads += row["n"]

    return {
        "total_downloads": total_downloads,
        "total_size_bytes": int(total_size),
        "downloads_by_status": downloads_by_status,
    }


def set_media_type(md5: str, media_type: str, db_path: str | None = None) -> None:
    """Set media_type for the given md5.

    No-op if ``md5`` is empty or the row does not exist.
    """
    if not md5:
        logger.warning("set_media_type called without an md5 — skipping")
        return

    _ensure_table(db_path)
    with _connect(db_path) as conn:
        conn.execute(
            "UPDATE downloads SET media_type = ? WHERE md5 = ?",
            (media_type, md5),
        )
        conn.commit()
    logger.debug(f"Set media_type={media_type!r} for {md5[:8]}")


def backfill_media_type(db_path: str | None = None) -> int:
    """Set media_type='book' for completed rows that predate the audiobook feature.

    Safe to call repeatedly — only updates rows where media_type IS NULL and
    status = 'completed'. Returns the number of rows updated.
    """
    _ensure_table(db_path)
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "UPDATE downloads SET media_type = 'book' WHERE status = 'completed' AND media_type IS NULL"
        )
        conn.commit()
        return cursor.rowcount
