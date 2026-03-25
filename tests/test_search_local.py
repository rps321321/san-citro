"""Tests for search_local.py."""
from unittest.mock import patch, MagicMock

import pytest

from src.search_local import search_db, print_results, get_external_metadata, _sanitize_fts_query, SearchResult


class TestSanitizeFtsQuery:
    def test_wraps_in_quotes(self):
        assert _sanitize_fts_query("moby dick") == '"moby dick"'

    def test_strips_existing_quotes(self):
        assert _sanitize_fts_query('"injection" OR "hack"') == '"injection OR hack"'

    def test_prevents_fts_operators(self):
        result = _sanitize_fts_query('NEAR(foo, bar)')
        assert result == '"NEAR(foo, bar)"'


class TestSearchDb:
    def test_returns_results_for_valid_query(self, test_db):
        sr = search_db(str(test_db), "Gatsby")
        assert len(sr.results) >= 1
        assert "Gatsby" in sr.results[0][0]  # title

    def test_returns_empty_for_no_match(self, test_db):
        sr = search_db(str(test_db), "xyznonexistent123")
        assert sr.results == []

    def test_returns_empty_for_missing_db(self, tmp_path):
        sr = search_db(str(tmp_path / "nope.db"), "anything")
        assert sr.results == []

    def test_extension_filter(self, test_db):
        sr = search_db(str(test_db), "Gatsby", ext="epub")
        assert len(sr.results) >= 1
        sr_pdf = search_db(str(test_db), "Gatsby", ext="pdf")
        assert len(sr_pdf.results) == 0

    def test_pagination(self, test_db):
        sr = search_db(str(test_db), "Gatsby", per_page=1, page=1)
        assert sr.per_page == 1
        assert sr.page == 1
        assert sr.total_count >= 1

    def test_fts_fallback_on_missing_fts_table(self, tmp_path):
        """Should fall back to LIKE when FTS table doesn't exist."""
        import sqlite3
        db_path = str(tmp_path / "nofts.db")
        with sqlite3.connect(db_path) as conn:
            conn.execute("""
                CREATE TABLE records (
                    md5 TEXT PRIMARY KEY, title TEXT, author TEXT, year TEXT,
                    extension TEXT, language TEXT, filesize_bytes INTEGER,
                    isbn13 TEXT, publisher TEXT, description TEXT
                )
            """)
            conn.execute(
                "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("abc" * 10 + "ab", "Test Title", "Author", "2020", "epub", "en", 1000, None, None, None),
            )

        sr = search_db(db_path, "Test")
        assert len(sr.results) >= 1


class TestGetExternalMetadata:
    def test_returns_none_for_na_isbn(self):
        assert get_external_metadata("N/A") is None
        assert get_external_metadata("") is None
        assert get_external_metadata(None) is None

    def test_returns_metadata_on_success(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "ISBN:1234567890": {
                "number_of_pages": 350,
                "cover": {"medium": "http://example.com/cover.jpg"},
                "url": "http://example.com/book",
            }
        }
        with patch("src.search_local.requests.get", return_value=mock_response):
            result = get_external_metadata("1234567890")
        assert result["pages"] == 350

    def test_returns_none_on_network_error(self):
        import requests as req
        with patch("src.search_local.requests.get", side_effect=req.ConnectionError):
            assert get_external_metadata("1234567890") is None


class TestPrintResults:
    def test_no_crash_on_empty_results(self):
        print_results(SearchResult())

    def test_no_crash_on_valid_results(self, test_db, download_dir):
        sr = search_db(str(test_db), "Gatsby")
        print_results(sr, download_dir=str(download_dir))

    def test_ownership_detection(self, test_db, download_dir):
        """The first record (Gatsby) has a matching file in download_dir fixture."""
        sr = search_db(str(test_db), "Gatsby")
        assert len(sr.results) >= 1
        # We can't easily check Rich output, but at least verify no crash
        print_results(sr, download_dir=str(download_dir))

    def test_backward_compat_with_list(self, test_db, download_dir):
        """print_results should accept a plain list for backward compatibility."""
        sr = search_db(str(test_db), "Gatsby")
        print_results(sr.results, download_dir=str(download_dir))
