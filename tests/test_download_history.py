"""Tests for src/download_history.py"""

import sqlite3
from pathlib import Path

import pytest

from src.download_history import (
    _migrate_meta_columns,
    get_completed_md5s,
    get_download_history,
    get_download_stats,
    init_downloads_table,
    is_downloaded,
    record_download_cancelled,
    record_download_complete,
    record_download_failed,
    record_download_start,
)

# The legacy (pre-metadata) schema, used to prove the guarded migration adds
# only the missing columns and is safe to run repeatedly.
_LEGACY_SCHEMA = """
    CREATE TABLE downloads (
        md5             TEXT PRIMARY KEY,
        title           TEXT,
        filename        TEXT,
        status          TEXT,
        started_at      TIMESTAMP,
        completed_at    TIMESTAMP,
        filesize_bytes  INTEGER,
        error           TEXT
    )
"""
_META_COLUMNS = (
    "author",
    "year",
    "extension",
    "content_type",
    "language",
    "publisher",
    "cover_url",
)


@pytest.fixture()
def history_db(tmp_path: Path) -> str:
    """Provide a temporary SQLite database path for each test."""
    return str(tmp_path / "test_history.db")


class TestInitDownloadsTable:
    def test_should_create_table_when_database_is_new(self, history_db: str) -> None:
        init_downloads_table(history_db)

        with sqlite3.connect(history_db) as conn:
            cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'")
            assert cursor.fetchone() is not None

    def test_should_have_expected_columns_when_table_created(self, history_db: str) -> None:
        init_downloads_table(history_db)

        with sqlite3.connect(history_db) as conn:
            cursor = conn.execute("PRAGMA table_info(downloads)")
            columns = {row[1] for row in cursor.fetchall()}

        expected = {
            "md5",
            "title",
            "filename",
            "status",
            "started_at",
            "completed_at",
            "filesize_bytes",
            "error",
            # Metadata-spine columns added by the guarded migration.
            "author",
            "year",
            "extension",
            "content_type",
            "language",
            "publisher",
            "cover_url",
        }
        assert columns == expected

    def test_should_be_idempotent_when_called_twice(self, history_db: str) -> None:
        init_downloads_table(history_db)
        init_downloads_table(history_db)
        # No exception means success


class TestRecordDownloadStart:
    def test_should_insert_row_when_new_md5(self, history_db: str) -> None:
        record_download_start(history_db, md5="abc123", title="Test Book")

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'abc123'").fetchone()

        assert row is not None
        assert row["title"] == "Test Book"
        assert row["status"] == "started"
        assert row["started_at"] is not None

    def test_should_preserve_prior_success_metadata_when_restarting_completed_md5(self, history_db: str) -> None:
        record_download_start(history_db, md5="abc123", title="First Try")
        record_download_complete(history_db, md5="abc123", filename="f.pdf", filesize_bytes=100)
        # Re-start the same already-completed download
        record_download_start(history_db, md5="abc123", title="Second Try")

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'abc123'").fetchone()

        assert row["status"] == "started"
        assert row["title"] == "Second Try"
        assert row["error"] is None
        # Preserve-on-restart: prior success metadata survives the new 'started'.
        assert row["filename"] == "f.pdf"
        assert row["filesize_bytes"] == 100
        assert row["completed_at"] is not None

    def test_should_not_lose_prior_success_when_retry_fails(self, history_db: str) -> None:
        record_download_start(history_db, md5="abc123", title="First Try")
        record_download_complete(history_db, md5="abc123", filename="f.pdf", filesize_bytes=100)
        record_download_start(history_db, md5="abc123", title="Second Try")
        record_download_failed(history_db, md5="abc123", error="boom")

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'abc123'").fetchone()

        assert row["status"] == "failed"
        assert row["filename"] == "f.pdf"
        assert row["filesize_bytes"] == 100

    def test_should_not_overwrite_cancelled_with_completed(self, history_db: str) -> None:
        record_download_start(history_db, md5="abc123", title="Job")
        record_download_cancelled(history_db, md5="abc123")
        record_download_complete(history_db, md5="abc123", filename="f.pdf", filesize_bytes=100)

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'abc123'").fetchone()

        assert row["status"] == "cancelled"

    def test_should_not_overwrite_cancelled_with_failed(self, history_db: str) -> None:
        record_download_start(history_db, md5="abc123", title="Job")
        record_download_cancelled(history_db, md5="abc123")
        record_download_failed(history_db, md5="abc123", error="boom")

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'abc123'").fetchone()

        assert row["status"] == "cancelled"

    def test_should_skip_when_md5_is_empty(self, history_db: str) -> None:
        init_downloads_table(history_db)
        record_download_start(history_db, md5="", title="No MD5")

        with sqlite3.connect(history_db) as conn:
            count = conn.execute("SELECT COUNT(*) FROM downloads").fetchone()[0]

        assert count == 0


class TestRecordDownloadComplete:
    def test_should_update_status_when_download_finishes(self, history_db: str) -> None:
        record_download_start(history_db, md5="def456", title="Good Book")
        record_download_complete(history_db, md5="def456", filename="good.pdf", filesize_bytes=5000)

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'def456'").fetchone()

        assert row["status"] == "completed"
        assert row["filename"] == "good.pdf"
        assert row["filesize_bytes"] == 5000
        assert row["completed_at"] is not None


class TestRecordDownloadFailed:
    def test_should_store_error_message_when_download_fails(self, history_db: str) -> None:
        record_download_start(history_db, md5="fail99", title="Bad Book")
        record_download_failed(history_db, md5="fail99", error="Connection timeout")

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'fail99'").fetchone()

        assert row["status"] == "failed"
        assert row["error"] == "Connection timeout"
        assert row["completed_at"] is not None


class TestGetDownloadHistory:
    def test_should_return_empty_list_when_no_records(self, history_db: str) -> None:
        assert get_download_history(history_db) == []

    def test_should_return_records_in_newest_first_order(self, history_db: str) -> None:
        record_download_start(history_db, md5="aaa", title="First")
        record_download_start(history_db, md5="bbb", title="Second")
        record_download_start(history_db, md5="ccc", title="Third")

        history = get_download_history(history_db)

        assert len(history) == 3
        assert history[0]["title"] == "Third"
        assert history[2]["title"] == "First"

    def test_should_respect_limit_parameter(self, history_db: str) -> None:
        for i in range(10):
            record_download_start(history_db, md5=f"md5_{i:03d}", title=f"Book {i}")

        history = get_download_history(history_db, limit=3)
        assert len(history) == 3

    def test_should_return_dict_rows_with_all_fields(self, history_db: str) -> None:
        record_download_start(history_db, md5="xyz", title="Dict Test")

        history = get_download_history(history_db, limit=1)
        row = history[0]

        expected_keys = {
            "md5",
            "title",
            "filename",
            "status",
            "started_at",
            "completed_at",
            "filesize_bytes",
            "error",
        }
        assert set(row.keys()) == expected_keys


class TestIsDownloaded:
    def test_should_return_true_when_download_is_completed(self, history_db: str) -> None:
        record_download_start(history_db, md5="done1", title="Done")
        record_download_complete(history_db, md5="done1", filename="done.pdf", filesize_bytes=999)

        assert is_downloaded(history_db, md5="done1") is True

    def test_should_return_false_when_download_is_only_started(self, history_db: str) -> None:
        record_download_start(history_db, md5="pend1", title="Pending")

        assert is_downloaded(history_db, md5="pend1") is False

    def test_should_return_false_when_download_failed(self, history_db: str) -> None:
        record_download_start(history_db, md5="bad1", title="Bad")
        record_download_failed(history_db, md5="bad1", error="oops")

        assert is_downloaded(history_db, md5="bad1") is False

    def test_should_return_false_when_md5_not_found(self, history_db: str) -> None:
        init_downloads_table(history_db)
        assert is_downloaded(history_db, md5="nonexistent") is False

    def test_should_return_false_when_md5_is_empty(self, history_db: str) -> None:
        assert is_downloaded(history_db, md5="") is False


class TestGetDownloadStats:
    def test_should_return_zeros_when_database_is_empty(self, history_db: str) -> None:
        stats = get_download_stats(history_db)

        assert stats["total_downloads"] == 0
        assert stats["total_size_bytes"] == 0
        assert stats["downloads_by_status"] == {}

    def test_should_return_correct_counts_when_populated(self, history_db: str) -> None:
        record_download_start(history_db, md5="ok1", title="One")
        record_download_complete(history_db, md5="ok1", filename="one.pdf", filesize_bytes=100)
        record_download_start(history_db, md5="ok2", title="Two")
        record_download_complete(history_db, md5="ok2", filename="two.pdf", filesize_bytes=250)
        record_download_start(history_db, md5="bad1", title="Bad")
        record_download_failed(history_db, md5="bad1", error="oops")
        record_download_start(history_db, md5="pend1", title="Pending")

        stats = get_download_stats(history_db)

        assert stats["total_downloads"] == 4
        assert stats["total_size_bytes"] == 350  # completed only
        assert stats["downloads_by_status"] == {
            "completed": 2,
            "failed": 1,
            "started": 1,
        }


class TestGetCompletedMd5s:
    def test_should_return_only_completed_md5s(self, history_db: str) -> None:
        record_download_start(history_db, md5="a" * 32, title="A")
        record_download_complete(history_db, md5="a" * 32, filename="a.epub", filesize_bytes=10)
        record_download_start(history_db, md5="b" * 32, title="B")  # started, not completed

        result = get_completed_md5s(history_db, ["a" * 32, "b" * 32, "c" * 32])

        assert result == {"a" * 32}

    def test_should_return_empty_set_for_empty_input(self, history_db: str) -> None:
        assert get_completed_md5s(history_db, []) == set()


class TestRecordDownloadStartMeta:
    def test_should_persist_meta_fields_when_provided(self, history_db: str) -> None:
        meta = {
            "author": "Ada Lovelace",
            "year": 1843,
            "extension": "pdf",
            "content_type": "non-fiction",
            "language": "English",
            "publisher": "Analytical Press",
            "cover_url": "https://example.com/c.jpg",
        }
        record_download_start(history_db, md5="meta1", title="With Meta", meta=meta)

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'meta1'").fetchone()

        assert row["title"] == "With Meta"
        assert row["status"] == "started"
        for key, value in meta.items():
            assert row[key] == value

    def test_should_leave_meta_columns_null_when_meta_absent(self, history_db: str) -> None:
        record_download_start(history_db, md5="nometa", title="No Meta")

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'nometa'").fetchone()

        for col in _META_COLUMNS:
            assert row[col] is None

    def test_should_persist_only_present_meta_keys(self, history_db: str) -> None:
        # Partial meta: only some keys, plus an explicit None that must stay NULL.
        meta = {"author": "Solo Author", "year": None, "content_type": "fiction"}
        record_download_start(history_db, md5="partial", title="Partial", meta=meta)

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'partial'").fetchone()

        assert row["author"] == "Solo Author"
        assert row["content_type"] == "fiction"
        assert row["year"] is None
        assert row["extension"] is None

    def test_should_update_meta_on_conflict_when_restarting(self, history_db: str) -> None:
        record_download_start(history_db, md5="upd", title="v1", meta={"author": "Old"})
        record_download_start(history_db, md5="upd", title="v2", meta={"author": "New", "year": 2020})

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'upd'").fetchone()

        assert row["title"] == "v2"
        assert row["author"] == "New"
        assert row["year"] == 2020


class TestGuardedMetaMigration:
    def test_should_add_missing_columns_to_legacy_table(self, history_db: str) -> None:
        # Build a legacy table that predates the metadata-spine columns.
        with sqlite3.connect(history_db) as conn:
            conn.executescript(_LEGACY_SCHEMA)
            conn.commit()

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            _migrate_meta_columns(conn)
            conn.commit()
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(downloads)")}

        for col in _META_COLUMNS:
            assert col in cols

    def test_should_be_safe_to_run_twice(self, history_db: str) -> None:
        with sqlite3.connect(history_db) as conn:
            conn.executescript(_LEGACY_SCHEMA)
            conn.commit()

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            _migrate_meta_columns(conn)
            # Second run must be a no-op, not an "duplicate column" error.
            _migrate_meta_columns(conn)
            conn.commit()
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(downloads)")}

        for col in _META_COLUMNS:
            assert col in cols

    def test_should_preserve_existing_rows_through_migration(self, history_db: str) -> None:
        with sqlite3.connect(history_db) as conn:
            conn.executescript(_LEGACY_SCHEMA)
            conn.execute("INSERT INTO downloads (md5, title, status) VALUES ('legacy1', 'Old Row', 'completed')")
            conn.commit()

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            _migrate_meta_columns(conn)
            conn.commit()
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'legacy1'").fetchone()

        assert row["title"] == "Old Row"
        assert row["status"] == "completed"
        assert row["author"] is None
