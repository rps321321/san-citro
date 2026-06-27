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
