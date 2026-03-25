"""Tests for download_strategy.py -- all network calls mocked."""
import re
from pathlib import Path
from unittest.mock import patch, MagicMock, PropertyMock

import pytest

from src.download_strategy import (
    ChromeStrategy,
    DirectHTTPStrategy,
    DownloadStrategy,
    create_strategy,
)

VALID_MD5 = "72a7e9cb2b7a5c9d03f6ae095745a1fa"
BASE_URL = "https://annas-archive.gl"
SLOW_URL = f"{BASE_URL}/slow_download/abc123/0"


class TestCreateStrategy:
    def test_creates_chrome_strategy(self):
        s = create_strategy("chrome")
        assert isinstance(s, ChromeStrategy)

    def test_creates_direct_strategy(self):
        s = create_strategy("direct")
        assert isinstance(s, DirectHTTPStrategy)

    def test_raises_on_unknown_strategy(self):
        with pytest.raises(ValueError, match="Unknown strategy"):
            create_strategy("nonexistent")

    def test_strategies_implement_protocol(self):
        """Both strategies are subclasses of DownloadStrategy."""
        assert issubclass(ChromeStrategy, DownloadStrategy)
        assert issubclass(DirectHTTPStrategy, DownloadStrategy)


class TestDirectHTTPStrategyExtractCountdown:
    """Unit tests for the countdown extraction logic."""

    def _make_strategy(self) -> DirectHTTPStrategy:
        return DirectHTTPStrategy()

    def _make_soup(self, html: str):
        from bs4 import BeautifulSoup
        return BeautifulSoup(html, "html.parser")

    def test_extracts_js_countdown_variable(self):
        strategy = self._make_strategy()
        html = "<script>var countdown = 10;</script>"
        soup = self._make_soup(html)
        assert strategy._extract_countdown(soup, html) == 10

    def test_extracts_js_seconds_variable(self):
        strategy = self._make_strategy()
        html = "<script>let seconds = 7;</script>"
        soup = self._make_soup(html)
        assert strategy._extract_countdown(soup, html) == 7

    def test_extracts_settimeout_milliseconds(self):
        strategy = self._make_strategy()
        html = '<script>setTimeout(function(){ reveal(); }, 5000);</script>'
        soup = self._make_soup(html)
        assert strategy._extract_countdown(soup, html) == 5

    def test_extracts_data_countdown_attribute(self):
        strategy = self._make_strategy()
        html = '<div data-countdown="15">Loading...</div>'
        soup = self._make_soup(html)
        # JS patterns won't match, so it falls through to data attributes
        assert strategy._extract_countdown(soup, html) == 15

    def test_extracts_from_countdown_id_element(self):
        strategy = self._make_strategy()
        html = '<span id="countdown">30</span>'
        soup = self._make_soup(html)
        assert strategy._extract_countdown(soup, html) == 30

    def test_extracts_from_timer_class_element(self):
        strategy = self._make_strategy()
        html = '<div class="timer-display">20 seconds remaining</div>'
        soup = self._make_soup(html)
        assert strategy._extract_countdown(soup, html) == 20

    def test_defaults_to_five_when_no_countdown_found(self):
        strategy = self._make_strategy()
        html = "<html><body><p>Hello world</p></body></html>"
        soup = self._make_soup(html)
        assert strategy._extract_countdown(soup, html) == 5

    def test_ignores_unreasonable_countdown_values(self):
        strategy = self._make_strategy()
        html = "<script>countdown = 999;</script>"
        soup = self._make_soup(html)
        # 999 > 120, so it should be skipped; defaults to 5
        assert strategy._extract_countdown(soup, html) == 5


class TestDirectHTTPStrategyExtractDownloadLink:
    def _make_strategy(self) -> DirectHTTPStrategy:
        return DirectHTTPStrategy()

    def _make_soup(self, html: str):
        from bs4 import BeautifulSoup
        return BeautifulSoup(html, "html.parser")

    def test_extracts_link_with_download_text(self):
        strategy = self._make_strategy()
        html = '<a href="https://cdn.example.com/d3/y/1774443509/10000/g4/libgens_nonfiction/book.pdf">Download Now</a>'
        soup = self._make_soup(html)
        result = strategy._extract_download_link(soup, BASE_URL)
        assert result == "https://cdn.example.com/d3/y/1774443509/10000/g4/libgens_nonfiction/book.pdf"

    def test_ignores_self_referencing_links(self):
        strategy = self._make_strategy()
        html = f'<a href="{BASE_URL}/some/page">Download</a>'
        soup = self._make_soup(html)
        result = strategy._extract_download_link(soup, BASE_URL)
        assert result is None

    def test_ignores_anchor_links(self):
        strategy = self._make_strategy()
        html = '<a href="https://example.com/page#">Download</a>'
        soup = self._make_soup(html)
        result = strategy._extract_download_link(soup, BASE_URL)
        assert result is None

    def test_extracts_html5_download_attribute_link(self):
        strategy = self._make_strategy()
        html = '<a href="https://cdn.example.com/d3/y/1774443509/g4/libgens/book.epub" download="book.epub">Click</a>'
        soup = self._make_soup(html)
        result = strategy._extract_download_link(soup, BASE_URL)
        assert result == "https://cdn.example.com/d3/y/1774443509/g4/libgens/book.epub"

    def test_extracts_meta_refresh_redirect(self):
        strategy = self._make_strategy()
        html = '<meta http-equiv="refresh" content="0;url=https://cdn.example.com/d3/y/1774443509/g4/libgens/file.pdf">'
        soup = self._make_soup(html)
        result = strategy._extract_download_link(soup, BASE_URL)
        assert result == "https://cdn.example.com/d3/y/1774443509/g4/libgens/file.pdf"

    def test_returns_none_when_no_links(self):
        strategy = self._make_strategy()
        html = "<html><body><p>No links here</p></body></html>"
        soup = self._make_soup(html)
        result = strategy._extract_download_link(soup, BASE_URL)
        assert result is None


class TestDirectHTTPStrategyGetDownloadUrl:
    """Integration-level tests for the full get_download_url flow."""

    @patch("src.download_strategy.time.sleep")
    def test_should_return_url_when_link_found_on_first_fetch(self, mock_sleep):
        strategy = DirectHTTPStrategy()
        session = MagicMock()

        html = """
        <html><body>
        <script>var countdown = 3;</script>
        <a href="https://cdn.example.com/d3/y/1774443509/g4/libgens/file.pdf">Download Now</a>
        </body></html>
        """
        mock_resp = MagicMock()
        mock_resp.text = html
        mock_resp.raise_for_status = MagicMock()
        mock_resp.cookies = {}
        session.get.return_value = mock_resp

        result = strategy.get_download_url(SLOW_URL, VALID_MD5, session, BASE_URL)

        assert result is not None
        url, cookies, headers = result
        assert url == "https://cdn.example.com/d3/y/1774443509/g4/libgens/file.pdf"
        assert headers["User-Agent"] == DirectHTTPStrategy.USER_AGENT
        # Should have waited for countdown
        mock_sleep.assert_called_once_with(4)  # 3 + 1 safety margin

    @patch("src.download_strategy.time.sleep")
    def test_should_refetch_when_link_not_found_initially(self, mock_sleep):
        strategy = DirectHTTPStrategy()
        session = MagicMock()

        # First fetch: no download link
        html_no_link = "<html><body><p>Please wait...</p></body></html>"
        # Second fetch: download link appears
        html_with_link = (
            '<html><body>'
            '<a href="https://cdn.example.com/d3/y/1774443509/g4/libgens/file.epub">Download</a>'
            '</body></html>'
        )

        resp1 = MagicMock()
        resp1.text = html_no_link
        resp1.raise_for_status = MagicMock()
        resp1.cookies = {}

        resp2 = MagicMock()
        resp2.text = html_with_link
        resp2.raise_for_status = MagicMock()
        resp2.cookies = {}

        session.get.side_effect = [resp1, resp2]

        result = strategy.get_download_url(SLOW_URL, VALID_MD5, session, BASE_URL)

        assert result is not None
        url, _, _ = result
        assert url == "https://cdn.example.com/d3/y/1774443509/g4/libgens/file.epub"

    def test_should_return_none_on_network_error(self):
        import requests

        strategy = DirectHTTPStrategy()
        session = MagicMock()
        session.get.side_effect = requests.ConnectionError("timeout")

        result = strategy.get_download_url(SLOW_URL, VALID_MD5, session, BASE_URL)
        assert result is None

    @patch("src.download_strategy.time.sleep")
    def test_should_return_none_when_no_link_found_after_refetch(self, mock_sleep):
        strategy = DirectHTTPStrategy()
        session = MagicMock()

        html_no_link = "<html><body><p>No download available</p></body></html>"
        mock_resp = MagicMock()
        mock_resp.text = html_no_link
        mock_resp.raise_for_status = MagicMock()
        mock_resp.cookies = {}
        session.get.return_value = mock_resp

        result = strategy.get_download_url(SLOW_URL, VALID_MD5, session, BASE_URL)
        assert result is None


class TestChromeStrategy:
    def test_should_return_none_when_chromedriver_not_installed(self):
        strategy = ChromeStrategy()
        session = MagicMock()

        with patch.dict("sys.modules", {"undetected_chromedriver": None}):
            result = strategy.get_download_url(SLOW_URL, VALID_MD5, session, BASE_URL)
        assert result is None


class TestToolStrategyIntegration:
    """Tests that AnnasArchiveTool properly delegates to the configured strategy."""

    def test_tool_uses_provided_strategy(self):
        from src.annas_archive_tool import AnnasArchiveTool

        strategy = DirectHTTPStrategy()
        tool = AnnasArchiveTool(strategy=strategy)
        assert tool.strategy is strategy

    def test_tool_defaults_to_chrome_strategy(self):
        from src.annas_archive_tool import AnnasArchiveTool

        tool = AnnasArchiveTool()
        assert isinstance(tool.strategy, ChromeStrategy)

    @patch("src.download_strategy.time.sleep")
    def test_should_fallback_to_chrome_when_direct_fails(self, mock_sleep):
        from src.annas_archive_tool import AnnasArchiveTool

        strategy = DirectHTTPStrategy()
        tool = AnnasArchiveTool(strategy=strategy)

        # Mock get_slow_download_link to return a URL
        with patch.object(tool, "get_slow_download_link", return_value=SLOW_URL):
            # DirectHTTPStrategy returns None (failure)
            with patch.object(
                strategy, "get_download_url", return_value=None
            ) as mock_direct:
                # ChromeStrategy also returns None (we don't have Chrome in test)
                with patch.object(
                    ChromeStrategy, "get_download_url", return_value=None
                ) as mock_chrome:
                    result = tool.automated_slow_download(VALID_MD5)

        assert result is None
        mock_direct.assert_called_once()
        mock_chrome.assert_called_once()
