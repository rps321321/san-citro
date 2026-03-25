"""Tests for the lightweight database migration system."""

import sqlite3
from pathlib import Path

import pytest

from src.migrations import (
    get_current_version,
    get_migration_history,
    get_registered_migrations,
    run_migrations,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _table_exists(db_path: str, table_name: str) -> bool:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,),
        ).fetchone()
        return row[0] > 0


def _get_columns(db_path: str, table_name: str) -> set:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        return {row[1] for row in rows}


def _index_exists(db_path: str, index_name: str) -> bool:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
            (index_name,),
        ).fetchone()
        return row[0] > 0


# ---------------------------------------------------------------------------
# Tests: version tracking
# ---------------------------------------------------------------------------

class TestGetCurrentVersion:
    def test_should_return_zero_when_database_does_not_exist(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "nonexistent.db")
        assert get_current_version(db_path) == 0

    def test_should_return_zero_when_schema_version_table_missing(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "bare.db")
        sqlite3.connect(db_path).close()
        assert get_current_version(db_path) == 0

    def test_should_return_latest_version_after_migrations(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "migrated.db")
        run_migrations(db_path)
        all_migs = get_registered_migrations()
        assert get_current_version(db_path) == all_migs[-1].version


class TestGetMigrationHistory:
    def test_should_return_empty_list_for_fresh_database(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "fresh.db")
        assert get_migration_history(db_path) == []

    def test_should_return_all_applied_entries(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "hist.db")
        run_migrations(db_path)
        history = get_migration_history(db_path)
        all_migs = get_registered_migrations()
        assert len(history) == len(all_migs)
        assert history[0]["version"] == 1


# ---------------------------------------------------------------------------
# Tests: migration runner
# ---------------------------------------------------------------------------

class TestRunMigrations:
    def test_should_apply_all_migrations_on_fresh_database(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "new.db")
        all_migs = get_registered_migrations()
        applied = run_migrations(db_path)
        assert applied == len(all_migs)
        assert get_current_version(db_path) == all_migs[-1].version

    def test_should_be_idempotent_on_repeated_calls(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "idem.db")
        first = run_migrations(db_path)
        second = run_migrations(db_path)
        assert first > 0
        assert second == 0

    def test_should_skip_already_applied_migrations(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "partial.db")
        # Apply all, then verify re-run skips everything
        run_migrations(db_path)
        version_before = get_current_version(db_path)
        applied = run_migrations(db_path)
        assert applied == 0
        assert get_current_version(db_path) == version_before


# ---------------------------------------------------------------------------
# Tests: concrete migration outcomes
# ---------------------------------------------------------------------------

class TestMigrationV1:
    def test_should_create_schema_version_table(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "v1.db")
        run_migrations(db_path)
        assert _table_exists(db_path, "schema_version")
        cols = _get_columns(db_path, "schema_version")
        assert {"version", "applied_at", "description"} <= cols


class TestMigrationV2:
    def test_should_create_downloads_table(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "v2.db")
        run_migrations(db_path)
        assert _table_exists(db_path, "downloads")
        cols = _get_columns(db_path, "downloads")
        assert {"id", "md5", "filename", "status", "started_at", "completed_at"} <= cols

    def test_should_create_downloads_indexes(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "v2idx.db")
        run_migrations(db_path)
        assert _index_exists(db_path, "idx_downloads_md5")
        assert _index_exists(db_path, "idx_downloads_status")


class TestMigrationV3:
    def test_should_create_ingest_metadata_table(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "v3.db")
        run_migrations(db_path)
        assert _table_exists(db_path, "ingest_metadata")
        cols = _get_columns(db_path, "ingest_metadata")
        assert {"filename", "file_size", "records_added", "completed_at", "byte_offset"} <= cols


class TestMigrationV4:
    def test_should_add_missing_columns_to_records_table(self, tmp_path: Path) -> None:
        """Create a records table with a minimal schema, then verify v4 adds missing columns."""
        db_path = str(tmp_path / "v4.db")
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "CREATE TABLE records (md5 TEXT PRIMARY KEY, title TEXT, author TEXT)"
            )
        run_migrations(db_path)
        cols = _get_columns(db_path, "records")
        assert "source" in cols
        assert "added_at" in cols
        assert "extension" in cols
        assert "language" in cols

    def test_should_handle_records_table_already_having_all_columns(
        self, tmp_path: Path
    ) -> None:
        """Run on a DB already created by init_db -- nothing should break."""
        from src.ingest_db import init_db

        db_path = str(tmp_path / "v4full.db")
        conn = init_db(db_path)
        conn.close()
        # Should not raise
        run_migrations(db_path)
        cols = _get_columns(db_path, "records")
        assert "source" in cols
        assert "added_at" in cols

    def test_should_create_expected_indexes(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "v4idx.db")
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "CREATE TABLE records (md5 TEXT PRIMARY KEY, title TEXT)"
            )
        run_migrations(db_path)
        assert _index_exists(db_path, "idx_records_isbn13")
        assert _index_exists(db_path, "idx_records_added_at")


# ---------------------------------------------------------------------------
# Tests: registered migrations sanity
# ---------------------------------------------------------------------------

class TestMigrationRegistry:
    def test_should_have_sequential_versions(self) -> None:
        migs = get_registered_migrations()
        versions = [m.version for m in migs]
        assert versions == list(range(1, len(migs) + 1))

    def test_should_have_non_empty_descriptions(self) -> None:
        for m in get_registered_migrations():
            assert m.description, f"Migration v{m.version} has empty description"
