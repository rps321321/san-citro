"""Tests for ingest_db.py."""
import sqlite3

import pytest

from src.ingest_db import init_db, ingest_file, optimize_db
from src.mock_data_generator import MOCK_RECORDS


class TestInitDb:
    def test_creates_tables_and_indexes(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        conn = init_db(db_path)
        cursor = conn.cursor()

        # Records table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='records'")
        assert cursor.fetchone() is not None

        # FTS table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='records_fts'")
        assert cursor.fetchone() is not None

        # Ingest metadata table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ingest_metadata'")
        assert cursor.fetchone() is not None

        # Secondary indexes exist
        cursor.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_records_extension'")
        assert cursor.fetchone() is not None

        conn.close()

    def test_idempotent_fts_creation(self, tmp_path):
        """Regression: old code dropped FTS on every init, destroying existing index."""
        db_path = str(tmp_path / "test.db")

        # First init + insert
        conn = init_db(db_path)
        conn.execute(
            "INSERT INTO records (md5, title, author) VALUES (?, ?, ?)",
            ("abc123def456789012345678901234ab", "Test Book", "Author"),
        )
        conn.commit()
        conn.close()

        # Second init should NOT destroy FTS data
        conn = init_db(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM records_fts")
        count = cursor.fetchone()[0]
        conn.close()

        assert count >= 1, "FTS data should survive second init_db call"


class TestIngestFile:
    def test_ingests_all_records(self, tmp_path, mock_zst_file):
        db_path = str(tmp_path / "ingest.db")
        ingest_file(db_path, str(mock_zst_file))

        with sqlite3.connect(db_path) as conn:
            count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        assert count == len(MOCK_RECORDS)

    def test_fts_populated_via_trigger(self, test_db):
        with sqlite3.connect(str(test_db)) as conn:
            fts_count = conn.execute("SELECT COUNT(*) FROM records_fts").fetchone()[0]
        assert fts_count == len(MOCK_RECORDS)

    def test_skips_malformed_lines(self, tmp_path, mock_zst_with_bad_lines):
        db_path = str(tmp_path / "bad_ingest.db")
        ingest_file(db_path, str(mock_zst_with_bad_lines))

        with sqlite3.connect(db_path) as conn:
            count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        assert count == 2  # Only the 2 valid records

    def test_duplicate_records_ignored(self, tmp_path, mock_zst_file):
        db_path = str(tmp_path / "dup.db")
        ingest_file(db_path, str(mock_zst_file))
        ingest_file(db_path, str(mock_zst_file))  # Ingest same data again

        with sqlite3.connect(db_path) as conn:
            count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        assert count == len(MOCK_RECORDS)  # No duplicates

    def test_exits_on_missing_file(self, tmp_path):
        with pytest.raises(SystemExit):
            ingest_file(str(tmp_path / "test.db"), "/nonexistent/file.jsonl.zst")

    def test_incremental_skip(self, tmp_path, mock_zst_file):
        """Already-ingested files should be skipped unless force=True."""
        db_path = str(tmp_path / "inc.db")
        ingest_file(db_path, str(mock_zst_file))
        # Second call should be a no-op (skip)
        ingest_file(db_path, str(mock_zst_file))

        with sqlite3.connect(db_path) as conn:
            count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        assert count == len(MOCK_RECORDS)


class TestOptimizeDb:
    def test_optimize_existing_db(self, test_db):
        optimize_db(str(test_db))  # Should not raise

    def test_optimize_nonexistent_db(self, tmp_path):
        optimize_db(str(tmp_path / "nope.db"))  # Should silently return
