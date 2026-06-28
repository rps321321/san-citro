"""Tests for Electron bridge handlers."""

import importlib
import sys
from pathlib import Path
from unittest.mock import patch

BRIDGE_DIR = Path(__file__).resolve().parents[1] / "electron-app" / "python"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

bridge_handlers = importlib.import_module("bridge_handlers")


def test_diagnostics_message_drops_duplicate_check_name():
    message = "Internet Connection: [bold green]ONLINE[/bold green]"

    cleaned = bridge_handlers._redact_sensitive_message("Internet Connection", True, message)

    assert cleaned == "ONLINE"


def test_search_has_next_uses_scraper_page_size():
    rows = [{"md5": f"{i:032x}"} for i in range(20)]

    with (
        patch.object(bridge_handlers, "get_config", return_value={"proxies": [], "history_db": None}),
        patch.object(bridge_handlers, "scrape_annas_archive", return_value=rows),
        patch.object(bridge_handlers, "get_completed_md5s", return_value=set()),
    ):
        result = bridge_handlers.handle_search({"query": "python"})

    assert result["total_count"] == 20
    assert result["has_next"] is False


def test_handle_list_library_returns_rows():
    fake_rows = [
        {
            "md5": "a" * 32,
            "title": "Test Book",
            "filename": "test.epub",
            "author": "Author A",
            "year": "2020",
            "extension": "epub",
            "content_type": "book",
            "language": "en",
            "publisher": "Publisher X",
            "cover_url": "https://example.com/cover.jpg",
            "filesize_bytes": 1024,
            "completed_at": "2024-01-01T00:00:00",
        }
    ]

    with (
        patch.object(bridge_handlers, "list_library", return_value=fake_rows),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
    ):
        result = bridge_handlers.handle_list_library({})

    assert result == fake_rows
    assert result[0]["md5"] == "a" * 32


def test_handle_list_library_propagates_error():
    import pytest

    with (
        patch.object(bridge_handlers, "list_library", side_effect=OSError("db gone")),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        pytest.raises(RuntimeError, match="Failed to retrieve library"),
    ):
        bridge_handlers.handle_list_library({})
