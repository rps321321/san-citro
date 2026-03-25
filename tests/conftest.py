"""Shared fixtures for the Anna's Archive test suite."""
import sys
import os
import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Generator

import pytest
import zstandard as zstd

# Ensure src/ is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from mock_data_generator import MOCK_RECORDS


@pytest.fixture
def tmp_dir(tmp_path: Path) -> Path:
    """Provides a clean temporary directory."""
    return tmp_path


@pytest.fixture
def mock_zst_file(tmp_path: Path) -> Path:
    """Creates a compressed .jsonl.zst test file with 5 records."""
    filepath = tmp_path / "test_data.jsonl.zst"
    cctx = zstd.ZstdCompressor()
    with open(filepath, "wb") as f:
        with cctx.stream_writer(f) as compressor:
            for record in MOCK_RECORDS:
                line = json.dumps(record) + "\n"
                compressor.write(line.encode("utf-8"))
    return filepath


@pytest.fixture
def mock_zst_with_bad_lines(tmp_path: Path) -> Path:
    """Creates a .jsonl.zst file with a mix of good and malformed lines."""
    filepath = tmp_path / "bad_data.jsonl.zst"
    cctx = zstd.ZstdCompressor()
    with open(filepath, "wb") as f:
        with cctx.stream_writer(f) as compressor:
            # Good record
            compressor.write(json.dumps(MOCK_RECORDS[0]).encode("utf-8") + b"\n")
            # Malformed JSON
            compressor.write(b"this is not json\n")
            # Empty line
            compressor.write(b"\n")
            # Another good record
            compressor.write(json.dumps(MOCK_RECORDS[1]).encode("utf-8") + b"\n")
    return filepath


@pytest.fixture
def test_db(tmp_path: Path, mock_zst_file: Path) -> Path:
    """Creates and populates a test database."""
    from ingest_db import ingest_file

    db_path = tmp_path / "test.db"
    ingest_file(str(db_path), str(mock_zst_file))
    return db_path


@pytest.fixture
def empty_db(tmp_path: Path) -> Path:
    """Creates an empty database with schema only."""
    from ingest_db import init_db

    db_path = tmp_path / "empty.db"
    conn = init_db(str(db_path))
    conn.close()
    return db_path


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    """Provides a temporary config file path."""
    return tmp_path / "test_config.json"


@pytest.fixture
def download_dir(tmp_path: Path) -> Path:
    """Creates a mock download directory with sample files."""
    dl_dir = tmp_path / "downloads"
    dl_dir.mkdir()
    # Create a fake "owned" file matching the first mock record's MD5
    (dl_dir / f"The_Great_Gatsby_{MOCK_RECORDS[0]['md5']}.epub").touch()
    return dl_dir
