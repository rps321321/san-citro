"""Shared fixtures for the Anna's Archive test suite."""
from pathlib import Path

import pytest

from src.mock_data_generator import MOCK_RECORDS


@pytest.fixture
def tmp_dir(tmp_path: Path) -> Path:
    """Provides a clean temporary directory."""
    return tmp_path


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
