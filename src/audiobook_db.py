"""Audiobook metadata store backed by the local SQLite download_history database.

This module owns the four audiobook table accessors (``audiobooks``,
``audiobook_chapters``, ``audiobook_progress``, ``audiobook_bookmarks``).
It reuses :func:`download_history._connect` so it shares the same connection
pragmas (WAL, busy_timeout, and crucially ``foreign_keys = ON`` for FK cascades).

Schema ownership lives in :mod:`migrations`. Callers must run
:func:`migrations.run_migrations` before using these helpers; query/write paths
never CREATE/ALTER or invoke migrations.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .download_history import _connect
from .logger import get_logger

logger = get_logger()


def record_audiobook(
    db_path: str | None = None,
    md5: str = "",
    container_type: str | None = None,
    folder_path: str | None = None,
    total_duration_seconds: float | None = None,
    track_count: int | None = None,
    status: str = "pending",
    error_message: str | None = None,
) -> None:
    """Upsert an audiobook row, stamping ``updated_at`` (and ``created_at`` on insert)."""
    if not md5:
        logger.warning("record_audiobook called without an md5 — skipping")
        return

    now = datetime.now(UTC).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO audiobooks (
                md5, container_type, folder_path, total_duration_seconds,
                track_count, status, error_message, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(md5) DO UPDATE SET
                container_type         = excluded.container_type,
                folder_path            = excluded.folder_path,
                total_duration_seconds = excluded.total_duration_seconds,
                track_count            = excluded.track_count,
                status                 = excluded.status,
                error_message          = excluded.error_message,
                updated_at             = excluded.updated_at
            """,
            (
                md5,
                container_type,
                folder_path,
                total_duration_seconds,
                track_count,
                status,
                error_message,
                now,
                now,
            ),
        )
        conn.commit()
    logger.debug(f"Recorded audiobook {md5[:8]} (status={status})")


def set_audiobook_status(
    db_path: str | None = None,
    md5: str = "",
    status: str = "",
    error_message: str | None = None,
) -> None:
    """Update an audiobook's processing status and stamp ``updated_at``."""
    if not md5:
        logger.warning("set_audiobook_status called without an md5 — skipping")
        return

    now = datetime.now(UTC).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE audiobooks
            SET status = ?, error_message = ?, updated_at = ?
            WHERE md5 = ?
            """,
            (status, error_message, now, md5),
        )
        conn.commit()
    logger.debug(f"Set audiobook {md5[:8]} status to {status}")


def replace_chapters(
    db_path: str | None = None,
    md5: str = "",
    chapters: list[dict[str, Any]] | None = None,
) -> None:
    """Replace all chapters for an md5: delete existing then bulk-insert in one tx.

    Each chapter dict carries: ``chapter_index``, ``rel_path``, ``file_size``,
    ``title``, ``start_offset_seconds``, ``duration_seconds``. Missing optional
    keys default to NULL (or 0 for ``start_offset_seconds``).
    """
    if not md5:
        logger.warning("replace_chapters called without an md5 — skipping")
        return

    rows = [
        (
            md5,
            ch["chapter_index"],
            ch["rel_path"],
            ch.get("file_size"),
            ch.get("title"),
            ch.get("start_offset_seconds", 0),
            ch.get("duration_seconds"),
        )
        for ch in (chapters or [])
    ]

    with _connect(db_path) as conn:
        conn.execute("DELETE FROM audiobook_chapters WHERE md5 = ?", (md5,))
        if rows:
            conn.executemany(
                """
                INSERT INTO audiobook_chapters (
                    md5, chapter_index, rel_path, file_size, title,
                    start_offset_seconds, duration_seconds
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        conn.commit()
    logger.debug(f"Replaced chapters for {md5[:8]} ({len(rows)} chapters)")


def get_audiobook(db_path: str | None = None, md5: str = "") -> dict[str, Any] | None:
    """Return the audiobook row for an md5, or None."""
    if not md5:
        return None
    with _connect(db_path) as conn:
        row = conn.execute("SELECT * FROM audiobooks WHERE md5 = ?", (md5,)).fetchone()
        return dict(row) if row else None


def get_audiobook_chapters(db_path: str | None = None, md5: str = "") -> list[dict[str, Any]]:
    """Return all chapters for an md5, ordered by ``chapter_index``."""
    if not md5:
        return []
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "SELECT * FROM audiobook_chapters WHERE md5 = ? ORDER BY chapter_index",
            (md5,),
        )
        return [dict(row) for row in cursor.fetchall()]


def get_chapter(db_path: str | None = None, chapter_id: int = 0) -> dict[str, Any] | None:
    """Return a single chapter row by its ``chapter_id``, or None."""
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM audiobook_chapters WHERE chapter_id = ?",
            (chapter_id,),
        ).fetchone()
        return dict(row) if row else None


def list_audiobooks(db_path: str | None = None) -> list[dict[str, Any]]:
    """Return all audiobooks joined with download title/cover_url, newest first."""
    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            SELECT a.md5, a.container_type, a.folder_path,
                   a.total_duration_seconds, a.track_count, a.status,
                   a.error_message, a.created_at, a.updated_at,
                   d.title, d.cover_url
            FROM audiobooks a
            LEFT JOIN downloads d ON d.md5 = a.md5
            ORDER BY a.created_at DESC
            """
        )
        return [dict(row) for row in cursor.fetchall()]


def get_audiobook_progress(db_path: str | None = None, md5: str = "") -> dict[str, Any] | None:
    """Return the saved playback progress for an md5, or None."""
    if not md5:
        return None
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM audiobook_progress WHERE md5 = ?",
            (md5,),
        ).fetchone()
        return dict(row) if row else None


def save_audiobook_progress(
    db_path: str | None = None,
    md5: str = "",
    chapter_id: int | None = None,
    file_position_seconds: float | None = None,
) -> None:
    """Upsert playback progress (current chapter + position) for an md5."""
    if not md5:
        logger.warning("save_audiobook_progress called without an md5 — skipping")
        return

    now = datetime.now(UTC).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO audiobook_progress (md5, chapter_id, file_position_seconds, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(md5) DO UPDATE SET
                chapter_id            = excluded.chapter_id,
                file_position_seconds = excluded.file_position_seconds,
                updated_at            = excluded.updated_at
            """,
            (md5, chapter_id, file_position_seconds, now),
        )
        conn.commit()
    logger.debug(f"Saved audiobook progress for {md5[:8]}")


def add_bookmark(
    db_path: str | None = None,
    md5: str = "",
    chapter_id: int | None = None,
    file_position_seconds: float = 0,
    label: str | None = None,
) -> int:
    """Insert a bookmark and return its new ``bookmark_id``."""
    now = datetime.now(UTC).isoformat()

    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            INSERT INTO audiobook_bookmarks (md5, chapter_id, file_position_seconds, label, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (md5, chapter_id, file_position_seconds, label, now),
        )
        conn.commit()
        return int(cursor.lastrowid or 0)


def list_bookmarks(db_path: str | None = None, md5: str = "") -> list[dict[str, Any]]:
    """Return all bookmarks for an md5, oldest first."""
    if not md5:
        return []
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "SELECT * FROM audiobook_bookmarks WHERE md5 = ? ORDER BY created_at, bookmark_id",
            (md5,),
        )
        return [dict(row) for row in cursor.fetchall()]


def delete_bookmark(db_path: str | None = None, md5: str = "", bookmark_id: int = 0) -> None:
    """Delete a bookmark, but only if it belongs to ``md5`` (ownership-checked)."""
    if not md5:
        logger.warning("delete_bookmark called without an md5 — skipping")
        return

    with _connect(db_path) as conn:
        conn.execute(
            "DELETE FROM audiobook_bookmarks WHERE bookmark_id = ? AND md5 = ?",
            (bookmark_id, md5),
        )
        conn.commit()


def delete_audiobook(db_path: str | None = None, md5: str = "") -> None:
    """Delete an audiobook; FK cascades wipe its chapters, progress, and bookmarks."""
    if not md5:
        logger.warning("delete_audiobook called without an md5 — skipping")
        return

    with _connect(db_path) as conn:
        conn.execute("DELETE FROM audiobooks WHERE md5 = ?", (md5,))
        conn.commit()
    logger.debug(f"Deleted audiobook {md5[:8]}")


def reset_stuck_audiobooks(db_path: str | None = None) -> int:
    """Reset any 'processing' audiobook back to 'pending' for a startup re-sweep.

    Mirrors :func:`download_history.cleanup_orphaned_downloads`: a row left in
    'processing' means the previous session died mid-extraction. Returns the
    number of rows reset.
    """
    now = datetime.now(UTC).isoformat()
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "UPDATE audiobooks SET status = 'pending', updated_at = ? WHERE status = 'processing'",
            (now,),
        )
        conn.commit()
        count = cursor.rowcount
        if count > 0:
            logger.info("Reset %d stuck audiobook(s) to 'pending' from previous session", count)
        return count
