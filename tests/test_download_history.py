"""Tests for src/download_history.py"""

import sqlite3
from pathlib import Path

import pytest

from src.download_history import (
    init_downloads_table,
    record_download_start,
    record_download_complete,
    record_download_failed,
    get_download_history,
    is_downloaded,
)


@pytest.fixture()
def history_db(tmp_path: Path) -> str:
    """Provide a temporary SQLite database path for each test."""
    return str(tmp_path / "test_history.db")


class TestInitDownloadsTable:
    def test_should_create_table_when_database_is_new(self, history_db: str) -> None:
        init_downloads_table(history_db)

        with sqlite3.connect(history_db) as conn:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'"
            )
            assert cursor.fetchone() is not None

    def test_should_have_expected_columns_when_table_created(self, history_db: str) -> None:
        init_downloads_table(history_db)

        with sqlite3.connect(history_db) as conn:
            cursor = conn.execute("PRAGMA table_info(downloads)")
            columns = {row[1] for row in cursor.fetchall()}

        expected = {
            "md5", "title", "filename", "status",
            "started_at", "completed_at", "filesize_bytes", "error",
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

    def test_should_reset_status_when_md5_already_exists(self, history_db: str) -> None:
        record_download_start(history_db, md5="abc123", title="First Try")
        record_download_complete(history_db, md5="abc123", filename="f.pdf", filesize_bytes=100)
        # Re-start the same download
        record_download_start(history_db, md5="abc123", title="Second Try")

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = 'abc123'").fetchone()

        assert row["status"] == "started"
        assert row["title"] == "Second Try"
        assert row["filename"] is None
        assert row["error"] is None

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
            "md5", "title", "filename", "status",
            "started_at", "completed_at", "filesize_bytes", "error",
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
