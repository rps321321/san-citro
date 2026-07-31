"""Lightweight SQLite schema-evolution module.

Sole production owner of the history DB shape. CLI and the Python bridge must
call :func:`run_migrations` before any query, cleanup, queue recovery, or
command registration that depends on persisted data.

Each migration runs in its own transaction. Version rows are written only on
success; failures roll back and re-raise so startup fails clearly.

Connection pragmas match :func:`download_history._connect` (WAL, busy_timeout,
NORMAL synchronous, foreign_keys ON) so evolution and query paths behave the same.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .logger import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable

logger = get_logger()


class SchemaMigrationError(Exception):
    """Raised when schema evolution fails; callers must halt normal startup.

    Attributes:
        db_path: Path of the database that failed to migrate (when known).
        version: Migration version that failed (when known).
    """

    def __init__(
        self,
        message: str,
        *,
        db_path: str | None = None,
        version: int | None = None,
    ) -> None:
        super().__init__(message)
        self.db_path = db_path
        self.version = version


# Nullable metadata columns on downloads (name -> SQLite type).
_DOWNLOAD_META_COLUMNS: dict[str, str] = {
    "author": "TEXT",
    "year": "INTEGER",
    "extension": "TEXT",
    "content_type": "TEXT",
    "language": "TEXT",
    "publisher": "TEXT",
    "cover_url": "TEXT",
    "media_type": "TEXT",
}

# ---------------------------------------------------------------------------
# Migration registry
# ---------------------------------------------------------------------------


@dataclass
class MigrationEntry:
    """Metadata for a single registered migration."""

    version: int
    description: str
    fn: Callable[[sqlite3.Cursor], None]


_MIGRATIONS: dict[int, MigrationEntry] = {}


def migration(version: int, description: str) -> Callable:
    """Decorator that registers a migration function.

    Example::

        @migration(2, "Create downloads table")
        def _m2(cursor: sqlite3.Cursor) -> None:
            cursor.execute("CREATE TABLE IF NOT EXISTS downloads (...)")
    """

    def decorator(fn: Callable[[sqlite3.Cursor], None]) -> Callable[[sqlite3.Cursor], None]:
        if version in _MIGRATIONS:
            raise ValueError(f"Duplicate migration version: {version}")
        _MIGRATIONS[version] = MigrationEntry(version=version, description=description, fn=fn)
        return fn

    return decorator


def get_registered_migrations() -> list[MigrationEntry]:
    """Return all registered migrations sorted by version."""
    return sorted(_MIGRATIONS.values(), key=lambda m: m.version)


# ---------------------------------------------------------------------------
# Connection (same pragmas as download_history._connect)
# ---------------------------------------------------------------------------


def _connect(db_path: str) -> sqlite3.Connection:
    """Open a connection with WAL / busy_timeout / foreign_keys for safe concurrent access."""
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ---------------------------------------------------------------------------
# Version helpers
# ---------------------------------------------------------------------------


def _has_schema_version_table(cursor: sqlite3.Cursor) -> bool:
    """Check whether the schema_version table already exists."""
    cursor.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_version'")
    return bool(cursor.fetchone()[0])


def get_current_version(db_path: str) -> int:
    """Return the highest applied migration version, or 0 if none."""
    if not Path(db_path).exists():
        return 0
    with _connect(db_path) as conn:
        cursor = conn.cursor()
        if not _has_schema_version_table(cursor):
            return 0
        cursor.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version")
        return int(cursor.fetchone()[0])


def get_migration_history(db_path: str) -> list[dict]:
    """Return the full migration history for display purposes."""
    if not Path(db_path).exists():
        return []
    with _connect(db_path) as conn:
        cursor = conn.cursor()
        if not _has_schema_version_table(cursor):
            return []
        cursor.execute("SELECT version, applied_at, description FROM schema_version ORDER BY version")
        return [{"version": row[0], "applied_at": row[1], "description": row[2]} for row in cursor.fetchall()]


# ---------------------------------------------------------------------------
# Migration runner
# ---------------------------------------------------------------------------


def run_migrations(db_path: str) -> int:
    """Apply all pending migrations to *db_path* and return the count applied.

    Each migration runs inside its own transaction.  If a migration fails the
    transaction is rolled back and a :class:`SchemaMigrationError` is raised
    (wrapping the original cause) so the caller can fail startup clearly.
    Already-applied migrations are skipped, making the function safe to call
    repeatedly.
    """
    try:
        conn = _connect(db_path)
    except Exception as exc:
        raise SchemaMigrationError(
            f"Database schema migration failed for {db_path}: {exc}",
            db_path=db_path,
            version=None,
        ) from exc

    try:
        cursor = conn.cursor()

        current = 0
        if _has_schema_version_table(cursor):
            cursor.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version")
            current = int(cursor.fetchone()[0])

        pending = [m for m in get_registered_migrations() if m.version > current]
        if not pending:
            logger.info(f"Database is up to date at version {current}.")
            return 0

        applied = 0
        for mig in pending:
            logger.info(f"Applying migration v{mig.version}: {mig.description}")
            try:
                conn.execute("BEGIN")
                mig.fn(cursor)
                cursor.execute(
                    "INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)",
                    (mig.version, datetime.now(UTC).isoformat(), mig.description),
                )
                conn.commit()
                applied += 1
            except Exception as exc:
                conn.rollback()
                logger.error(f"Migration v{mig.version} failed — rolled back.")
                raise SchemaMigrationError(
                    f"Database schema migration failed for {db_path} at version {mig.version}: {exc}",
                    db_path=db_path,
                    version=mig.version,
                ) from exc

        logger.info(f"Applied {applied} migration(s). Now at version {pending[-1].version}.")
        return applied
    except SchemaMigrationError:
        raise
    except Exception as exc:
        raise SchemaMigrationError(
            f"Database schema migration failed for {db_path}: {exc}",
            db_path=db_path,
            version=None,
        ) from exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Concrete migrations (canonical history DB shape)
#
# Production never shipped the old records/ingest migrations, so the registered
# set is consolidated here. New databases must NOT create bulk-metadata tables
# (records, ingest_metadata). If those tables already exist on a legacy DB they
# are left untouched — no DROP, no rewrite.
# ---------------------------------------------------------------------------


@migration(1, "Create schema_version tracking table")
def _m1(cursor: sqlite3.Cursor) -> None:
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS schema_version (
            version     INTEGER PRIMARY KEY,
            applied_at  TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT ''
        )
    """)


@migration(2, "Create downloads table with full metadata columns")
def _m2(cursor: sqlite3.Cursor) -> None:
    # Full shape for brand-new tables. IF NOT EXISTS leaves existing tables alone.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS downloads (
            md5             TEXT PRIMARY KEY,
            title           TEXT,
            filename        TEXT,
            status          TEXT,
            started_at      TIMESTAMP,
            completed_at    TIMESTAMP,
            filesize_bytes  INTEGER,
            error           TEXT,
            author          TEXT,
            year            INTEGER,
            extension       TEXT,
            content_type    TEXT,
            language        TEXT,
            publisher       TEXT,
            cover_url       TEXT,
            media_type      TEXT
        )
    """)

    # Adoption: unversioned / partial downloads tables get missing columns only.
    cursor.execute("PRAGMA table_info(downloads)")
    existing = {row[1] for row in cursor.fetchall()}
    base_and_meta = [
        ("title", "TEXT"),
        ("filename", "TEXT"),
        ("status", "TEXT"),
        ("started_at", "TIMESTAMP"),
        ("completed_at", "TIMESTAMP"),
        ("filesize_bytes", "INTEGER"),
        ("error", "TEXT"),
        *list(_DOWNLOAD_META_COLUMNS.items()),
    ]
    for col_name, col_type in base_and_meta:
        if col_name not in existing:
            logger.info(f"  Adding missing column: downloads.{col_name} ({col_type})")
            cursor.execute(f"ALTER TABLE downloads ADD COLUMN {col_name} {col_type}")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_downloads_started_at ON downloads(started_at)")


@migration(3, "Create audiobook tables with indexes and foreign keys")
def _m3(cursor: sqlite3.Cursor) -> None:
    # Individual executes (not executescript) so the outer migration transaction
    # stays intact — sqlite3.Cursor.executescript issues an implicit COMMIT.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS audiobooks (
            md5                     TEXT PRIMARY KEY,
            container_type          TEXT,
            folder_path             TEXT,
            total_duration_seconds  REAL,
            track_count             INTEGER,
            status                  TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','processing','ready','unsupported','error')),
            error_message           TEXT,
            created_at              TIMESTAMP,
            updated_at              TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS audiobook_chapters (
            chapter_id              INTEGER PRIMARY KEY AUTOINCREMENT,
            md5                     TEXT NOT NULL REFERENCES audiobooks(md5) ON DELETE CASCADE,
            chapter_index           INTEGER NOT NULL,
            rel_path                TEXT NOT NULL,
            file_size               INTEGER,
            title                   TEXT,
            start_offset_seconds    REAL NOT NULL DEFAULT 0,
            duration_seconds        REAL,
            UNIQUE (md5, chapter_index)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS audiobook_progress (
            md5                     TEXT PRIMARY KEY REFERENCES audiobooks(md5) ON DELETE CASCADE,
            chapter_id              INTEGER REFERENCES audiobook_chapters(chapter_id) ON DELETE SET NULL,
            file_position_seconds   REAL,
            updated_at              TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS audiobook_bookmarks (
            bookmark_id             INTEGER PRIMARY KEY AUTOINCREMENT,
            md5                     TEXT NOT NULL REFERENCES audiobooks(md5) ON DELETE CASCADE,
            chapter_id              INTEGER,
            file_position_seconds   REAL NOT NULL,
            label                   TEXT,
            created_at              TIMESTAMP
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chapters_md5 ON audiobook_chapters(md5)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_bookmarks_md5 ON audiobook_bookmarks(md5)")
