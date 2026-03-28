"""Tests for export.py -- table, JSON, and CSV exporters."""
import csv
import io
import json
from pathlib import Path

import pytest

from src.export import export_table, export_json, export_csv, _is_owned
from src.utils import format_filesize
from src.mock_data_generator import MOCK_RECORDS


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_results():
    """Return a list of result tuples matching the search_db schema."""
    # (title, author, year, extension, md5, language, filesize_bytes, publisher, isbn13)
    return [
        ("The Great Gatsby", "F. Scott Fitzgerald", "1925", "epub",
         MOCK_RECORDS[0]["md5"], "en", 1_500_000, "Scribner", "9780743273565"),
        ("1984", "George Orwell", "1949", "pdf",
         MOCK_RECORDS[1]["md5"], "en", 800_000, "Secker & Warburg", "9780451524935"),
    ]


@pytest.fixture
def empty_results():
    return []


# ---------------------------------------------------------------------------
# format_filesize
# ---------------------------------------------------------------------------

class TestFormatSize:
    def test_should_return_mb_when_over_1mb(self):
        assert format_filesize(2_500_000) == "2.4 MB"

    def test_should_return_kb_when_under_1mb(self):
        assert format_filesize(512_000) == "500.0 KB"

    def test_should_return_na_when_none(self):
        assert format_filesize(None) == "N/A"

    def test_should_return_na_when_zero(self):
        assert format_filesize(0) == "N/A"


# ---------------------------------------------------------------------------
# _is_owned
# ---------------------------------------------------------------------------

class TestIsOwned:
    def test_should_detect_owned_file(self):
        md5 = "abc123def456"
        owned = {"book_abc123def456.epub", "other.pdf"}
        assert _is_owned(md5, owned) is True

    def test_should_return_false_when_not_owned(self):
        assert _is_owned("missing", {"other.pdf"}) is False

    def test_should_return_false_for_empty_set(self):
        assert _is_owned("anything", set()) is False


# ---------------------------------------------------------------------------
# export_json
# ---------------------------------------------------------------------------

class TestExportJson:
    def test_should_produce_valid_json_array(self, sample_results):
        output = export_json(sample_results, download_dir="nonexistent_dir_xyz")
        parsed = json.loads(output)
        assert isinstance(parsed, list)
        assert len(parsed) == 2

    def test_should_include_all_fields(self, sample_results):
        parsed = json.loads(export_json(sample_results, download_dir="nonexistent_dir_xyz"))
        record = parsed[0]
        assert record["title"] == "The Great Gatsby"
        assert record["md5"] == MOCK_RECORDS[0]["md5"]
        assert record["owned"] is False

    def test_should_write_to_file(self, sample_results, tmp_path):
        out_file = str(tmp_path / "results.json")
        export_json(sample_results, file=out_file, download_dir="nonexistent_dir_xyz")
        with open(out_file, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
        assert len(parsed) == 2

    def test_should_return_empty_array_for_no_results(self, empty_results):
        output = export_json(empty_results, download_dir="nonexistent_dir_xyz")
        assert json.loads(output) == []


# ---------------------------------------------------------------------------
# export_csv
# ---------------------------------------------------------------------------

class TestExportCsv:
    def test_should_produce_csv_with_header_and_rows(self, sample_results):
        output = export_csv(sample_results, download_dir="nonexistent_dir_xyz")
        reader = csv.reader(io.StringIO(output))
        rows = list(reader)
        # header + 2 data rows
        assert len(rows) == 3
        assert rows[0][0] == "title"

    def test_should_write_to_file(self, sample_results, tmp_path):
        out_file = str(tmp_path / "results.csv")
        export_csv(sample_results, file=out_file, download_dir="nonexistent_dir_xyz")
        with open(out_file, "r", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            rows = list(reader)
        assert len(rows) == 3

    def test_should_return_header_only_for_no_results(self, empty_results):
        output = export_csv(empty_results, download_dir="nonexistent_dir_xyz")
        reader = csv.reader(io.StringIO(output))
        rows = list(reader)
        assert len(rows) == 1  # header only


# ---------------------------------------------------------------------------
# export_table
# ---------------------------------------------------------------------------

class TestExportTable:
    def test_should_not_crash_on_empty_results(self, empty_results):
        """Empty results should print a message, not raise."""
        export_table(empty_results)

    def test_should_not_crash_on_valid_results(self, sample_results):
        export_table(sample_results, download_dir="nonexistent_dir_xyz")

    def test_should_write_to_file(self, sample_results, tmp_path):
        out_file = str(tmp_path / "results.txt")
        export_table(sample_results, file=out_file, download_dir="nonexistent_dir_xyz")
        content = Path(out_file).read_text(encoding="utf-8")
        assert "Great Gatsby" in content
        assert "1984" in content
