"""Tests for diagnostics.py."""
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from diagnostics import (
    check_internet,
    check_ip_address,
    check_site_reachability,
    check_database,
    check_chrome_automation,
    run_diagnostics,
)


class TestCheckInternet:
    def test_online(self):
        with patch("diagnostics.socket.create_connection"):
            success, msg = check_internet()
        assert success is True

    def test_offline(self):
        with patch("diagnostics.socket.create_connection", side_effect=OSError):
            success, msg = check_internet()
        assert success is False


class TestCheckIpAddress:
    def test_success(self):
        mock_resp = MagicMock()
        mock_resp.text = "1.2.3.4"
        with patch("diagnostics.requests.get", return_value=mock_resp):
            success, msg = check_ip_address()
        assert success is True
        assert "1.2.3.4" in msg

    def test_failure(self):
        import requests
        with patch("diagnostics.requests.get", side_effect=requests.ConnectionError):
            success, msg = check_ip_address()
        assert success is False


class TestCheckSiteReachability:
    def test_reachable(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        with patch("diagnostics.requests.get", return_value=mock_resp):
            success, msg = check_site_reachability("https://example.com")
        assert success is True

    def test_unreachable(self):
        import requests
        with patch("diagnostics.requests.get", side_effect=requests.ConnectionError):
            success, msg = check_site_reachability("https://example.com")
        assert success is False


class TestCheckDatabase:
    def test_healthy_db(self, test_db):
        success, msg = check_database(str(test_db))
        assert success is True
        assert "HEALTHY" in msg

    def test_missing_db(self, tmp_path):
        success, msg = check_database(str(tmp_path / "nope.db"))
        assert success is None

    def test_none_path(self):
        success, msg = check_database(None)
        assert success is None


class TestCheckChromeAutomation:
    def test_importable(self):
        with patch.dict("sys.modules", {"undetected_chromedriver": MagicMock()}):
            success, msg = check_chrome_automation()
        assert success is True

    def test_not_installed(self):
        with patch.dict("sys.modules", {"undetected_chromedriver": None}):
            # Force ImportError
            import builtins
            real_import = builtins.__import__

            def mock_import(name, *args, **kwargs):
                if name == "undetected_chromedriver":
                    raise ImportError("not installed")
                return real_import(name, *args, **kwargs)

            with patch("builtins.__import__", side_effect=mock_import):
                success, msg = check_chrome_automation()
            assert success is False


class TestRunDiagnostics:
    def test_no_crash(self):
        config = {"db_path": None}
        with patch("diagnostics.check_internet", return_value=(True, "OK")), \
             patch("diagnostics.check_ip_address", return_value=(True, "OK")), \
             patch("diagnostics.check_site_reachability", return_value=(True, "OK")), \
             patch("diagnostics.check_database", return_value=(None, "N/A")), \
             patch("diagnostics.check_chrome_automation", return_value=(True, "OK")):
            run_diagnostics(config)
