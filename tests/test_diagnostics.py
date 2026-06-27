"""Tests for diagnostics.py."""

from unittest.mock import MagicMock, patch

from src.diagnostics import (
    check_chrome_automation,
    check_internet,
    check_ip_address,
    check_site_reachability,
    run_diagnostics,
)


class TestCheckInternet:
    def test_online(self):
        with patch("src.diagnostics.socket.create_connection"):
            success, msg = check_internet()
        assert success is True

    def test_offline(self):
        with patch("src.diagnostics.socket.create_connection", side_effect=OSError):
            success, msg = check_internet()
        assert success is False


class TestCheckIpAddress:
    def test_success(self):
        mock_resp = MagicMock()
        mock_resp.text = "1.2.3.4"
        with patch("src.diagnostics.requests.get", return_value=mock_resp):
            success, msg = check_ip_address()
        assert success is True
        assert "1.2.3.4" in msg

    def test_failure(self):
        import requests

        with patch("src.diagnostics.requests.get", side_effect=requests.ConnectionError):
            success, msg = check_ip_address()
        assert success is False


class TestCheckSiteReachability:
    def test_reachable(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        with patch("src.diagnostics.requests.get", return_value=mock_resp):
            success, msg = check_site_reachability("https://example.com")
        assert success is True

    def test_unreachable(self):
        import requests

        with patch("src.diagnostics.requests.get", side_effect=requests.ConnectionError):
            success, msg = check_site_reachability("https://example.com")
        assert success is False


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
        # base_url is provided so run_diagnostics does not hit the network via
        # get_working_domain(); all network checks are mocked.
        config = {"base_url": "https://example.com", "proxies": []}
        with (
            patch("src.diagnostics.check_internet", return_value=(True, "OK")),
            patch("src.diagnostics.check_ip_address", return_value=(True, "OK")),
            patch("src.diagnostics.check_site_reachability", return_value=(True, "OK")),
            patch("src.diagnostics.check_chrome_automation", return_value=(True, "OK")),
            patch("src.diagnostics.check_tls_fingerprint", return_value=(True, "OK")),
            patch("src.diagnostics.check_proxies", return_value=(None, "N/A")),
        ):
            run_diagnostics(config)
