"""Lightweight SQLite database migration system.

Provides a decorator-based migration registry, version tracking via a
``schema_version`` table, and idempotent ``run_migrations`` that applies
only pending migrations inside individual transactions.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .logger import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable

logger = get_logger()

# Whitelist patterns for DDL-safe column name/type validation (compiled once).
_VALID_COL_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
_VALID_COL_TYPE = re.compile(r"^[A-Z]+$")

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
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        if not _has_schema_version_table(cursor):
            return 0
        cursor.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version")
        return int(cursor.fetchone()[0])


def get_migration_history(db_path: str) -> list[dict]:
    """Return the full migration history for display purposes."""
    if not Path(db_path).exists():
        return []
    with sqlite3.connect(db_path) as conn:
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
    transaction is rolled back and the error is re-raised so the caller can
    decide how to proceed.  Already-applied migrations are skipped, making the
    function safe to call repeatedly.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        cursor = conn.cursor()

        current = 0
        if _has_schema_version_table(cursor):
            cursor.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version")
            current = cursor.fetchone()[0]

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
            except Exception:
                conn.rollback()
                logger.error(f"Migration v{mig.version} failed — rolled back.")
                raise

        logger.info(f"Applied {applied} migration(s). Now at version {pending[-1].version}.")
        return applied
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Concrete migrations
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


@migration(2, "Create downloads table for tracking file downloads")
def _m2(cursor: sqlite3.Cursor) -> None:
    cursor.execute("""
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
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_downloads_started_at ON downloads(started_at)")


@migration(3, "Create ingest_metadata table for tracking data ingestion runs")
def _m3(cursor: sqlite3.Cursor) -> None:
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ingest_metadata (
            filename TEXT PRIMARY KEY,
            file_size INTEGER,
            records_added INTEGER,
            completed_at TIMESTAMP,
            byte_offset INTEGER
        )
    """)


@migration(4, "Ensure records table has all expected columns")
def _m4(cursor: sqlite3.Cursor) -> None:
    # Ensure the records table exists first.  On a brand-new database the
    # table may not have been created by init_db yet, so we create it with
    # the full canonical schema.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS records (
            md5 TEXT PRIMARY KEY,
            title TEXT,
            author TEXT,
            year TEXT,
            extension TEXT,
            language TEXT,
            filesize_bytes INTEGER,
            isbn13 TEXT,
            publisher TEXT,
            description TEXT,
            source TEXT,
            added_at TEXT
        )
    """)

    # Back-fill any columns that may be missing on databases created with an
    # older or partial schema.  We check every expected column and ALTER TABLE
    # ADD COLUMN for any that are absent.
    cursor.execute("PRAGMA table_info(records)")
    existing_columns = {row[1] for row in cursor.fetchall()}

    # Full list of expected non-PK columns (md5 is always present as PK).
    expected_columns = [
        ("title", "TEXT"),
        ("author", "TEXT"),
        ("year", "TEXT"),
        ("extension", "TEXT"),
        ("language", "TEXT"),
        ("filesize_bytes", "INTEGER"),
        ("isbn13", "TEXT"),
        ("publisher", "TEXT"),
        ("description", "TEXT"),
        ("source", "TEXT"),
        ("added_at", "TEXT"),
    ]

    for col_name, col_type in expected_columns:
        if col_name not in existing_columns:
            # Whitelist-validate to prevent DDL injection (even though values are hardcoded)
            assert _VALID_COL_NAME.match(col_name), f"Invalid column name: {col_name}"
            assert _VALID_COL_TYPE.match(col_type), f"Invalid column type: {col_type}"
            logger.info(f"  Adding missing column: records.{col_name} ({col_type})")
            cursor.execute(f"ALTER TABLE records ADD COLUMN {col_name} {col_type}")

    # Ensure standard indexes exist (idempotent)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_extension ON records(extension)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_language ON records(language)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_year ON records(year)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_isbn13 ON records(isbn13)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_added_at ON records(added_at)")


@migration(5, "Add records_processed column to ingest_metadata for record-count-based resume")
def _m5(cursor: sqlite3.Cursor) -> None:
    """Replace byte-offset resume with record-count resume.

    Zstd is a streaming codec — seeking to an arbitrary compressed byte
    offset produces garbage.  The new ``records_processed`` column tracks
    how many records have been seen so that resume can decompress from the
    beginning and skip the already-processed records.

    The old ``byte_offset`` column is kept for backward compatibility but
    is no longer written or used for resume logic.
    """
    cursor.execute("PRAGMA table_info(ingest_metadata)")
    existing_cols = {row[1] for row in cursor.fetchall()}
    if "records_processed" not in existing_cols:
        cursor.execute("ALTER TABLE ingest_metadata ADD COLUMN records_processed INTEGER DEFAULT 0")
    # Backfill: set records_processed = records_added for incomplete runs so
    # that an in-progress ingest can resume correctly after the upgrade.
    cursor.execute(
        "UPDATE ingest_metadata SET records_processed = records_added "
        "WHERE records_processed IS NULL OR records_processed = 0"
    )
