"""Lightweight SQLite database migration system.

Provides a decorator-based migration registry, version tracking via a
``schema_version`` table, and idempotent ``run_migrations`` that applies
only pending migrations inside individual transactions.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .logger import get_logger

logger = get_logger()

# ---------------------------------------------------------------------------
# Migration registry
# ---------------------------------------------------------------------------

@dataclass
class MigrationEntry:
    """Metadata for a single registered migration."""

    version: int
    description: str
    fn: Callable[[sqlite3.Cursor], None]


_MIGRATIONS: Dict[int, MigrationEntry] = {}


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


def get_registered_migrations() -> List[MigrationEntry]:
    """Return all registered migrations sorted by version."""
    return sorted(_MIGRATIONS.values(), key=lambda m: m.version)


# ---------------------------------------------------------------------------
# Version helpers
# ---------------------------------------------------------------------------

def _has_schema_version_table(cursor: sqlite3.Cursor) -> bool:
    """Check whether the schema_version table already exists."""
    cursor.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    return cursor.fetchone()[0] > 0


def get_current_version(db_path: str) -> int:
    """Return the highest applied migration version, or 0 if none."""
    if not Path(db_path).exists():
        return 0
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        if not _has_schema_version_table(cursor):
            return 0
        cursor.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version")
        return cursor.fetchone()[0]


def get_migration_history(db_path: str) -> List[Dict]:
    """Return the full migration history for display purposes."""
    if not Path(db_path).exists():
        return []
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        if not _has_schema_version_table(cursor):
            return []
        cursor.execute(
            "SELECT version, applied_at, description FROM schema_version ORDER BY version"
        )
        return [
            {"version": row[0], "applied_at": row[1], "description": row[2]}
            for row in cursor.fetchall()
        ]


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
    conn.execute("PRAGMA journal_mode = WAL")
    cursor = conn.cursor()

    current = 0
    if _has_schema_version_table(cursor):
        cursor.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version")
        current = cursor.fetchone()[0]

    pending = [m for m in get_registered_migrations() if m.version > current]
    if not pending:
        logger.info(f"Database is up to date at version {current}.")
        conn.close()
        return 0

    applied = 0
    for mig in pending:
        logger.info(f"Applying migration v{mig.version}: {mig.description}")
        try:
            conn.execute("BEGIN")
            mig.fn(cursor)
            cursor.execute(
                "INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)",
                (mig.version, datetime.now(timezone.utc).isoformat(), mig.description),
            )
            conn.commit()
            applied += 1
        except Exception:
            conn.rollback()
            logger.error(f"Migration v{mig.version} failed — rolled back.")
            conn.close()
            raise

    logger.info(f"Applied {applied} migration(s). Now at version {pending[-1].version}.")
    conn.close()
    return applied


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
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            md5           TEXT NOT NULL,
            filename      TEXT,
            output_dir    TEXT,
            file_path     TEXT,
            filesize_bytes INTEGER,
            started_at    TEXT NOT NULL,
            completed_at  TEXT,
            status        TEXT NOT NULL DEFAULT 'pending',
            error_message TEXT,
            UNIQUE(md5, file_path)
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_downloads_md5 ON downloads(md5)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status)")


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
            logger.info(f"  Adding missing column: records.{col_name} ({col_type})")
            cursor.execute(f"ALTER TABLE records ADD COLUMN {col_name} {col_type}")

    # Ensure standard indexes exist (idempotent)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_extension ON records(extension)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_language ON records(language)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_year ON records(year)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_isbn13 ON records(isbn13)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_added_at ON records(added_at)")
