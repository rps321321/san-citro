"""Tests for annas_archive_tool.py -- all network calls mocked."""
from unittest.mock import patch, MagicMock

import pytest

from src.annas_archive_tool import AnnasArchiveTool, MD5_PATTERN


class TestAnnasArchiveToolInit:
    def test_default_init(self):
        tool = AnnasArchiveTool()
        assert tool.base_url == "https://annas-archive.gl"
        assert tool.proxies == []
        assert tool.direct_mode is False
        assert tool.session is not None

    def test_init_with_proxies(self):
        tool = AnnasArchiveTool(proxies=["1.2.3.4:8080"], direct_mode=True)
        assert tool.proxies == ["1.2.3.4:8080"]
        assert tool.direct_mode is True


class TestMD5Validation:
    def test_valid_md5(self):
        assert MD5_PATTERN.match("72a7e9cb2b7a5c9d03f6ae095745a1fa")

    def test_invalid_md5(self):
        assert not MD5_PATTERN.match("not-an-md5")
        assert not MD5_PATTERN.match("../../etc/passwd")
        assert not MD5_PATTERN.match("")


class TestGetSlowDownloadLink:
    def test_returns_link_on_success(self):
        tool = AnnasArchiveTool()
        html = '<html><body><a href="/slow_download/abc123/0">Download</a></body></html>'
        mock_resp = MagicMock()
        mock_resp.text = html
        mock_resp.raise_for_status = MagicMock()
        with patch.object(tool.session, "get", return_value=mock_resp):
            link = tool.get_slow_download_link("72a7e9cb2b7a5c9d03f6ae095745a1fa")
        assert link == "https://annas-archive.gl/slow_download/abc123/0"

    def test_returns_none_on_invalid_md5(self):
        tool = AnnasArchiveTool()
        assert tool.get_slow_download_link("bad-hash") is None

    def test_returns_none_on_network_error(self):
        tool = AnnasArchiveTool()
        import requests
        with patch.object(tool.session, "get", side_effect=requests.ConnectionError("timeout")):
            assert tool.get_slow_download_link("72a7e9cb2b7a5c9d03f6ae095745a1fa") is None

    def test_rejects_untrusted_domain(self):
        tool = AnnasArchiveTool()
        html = '<html><body><a href="https://evil.com/slow_download/abc123">Download</a></body></html>'
        mock_resp = MagicMock()
        mock_resp.text = html
        mock_resp.raise_for_status = MagicMock()
        with patch.object(tool.session, "get", return_value=mock_resp):
            link = tool.get_slow_download_link("72a7e9cb2b7a5c9d03f6ae095745a1fa")
        assert link is None


class TestGetMetadataDumps:
    def test_returns_sorted_dumps(self):
        tool = AnnasArchiveTool()
        mock_data = [
            {"group_name": "aa_derived_mirror_metadata", "added_to_torrents_list_at": "2024-01-01", "display_name": "A"},
            {"group_name": "aa_derived_mirror_metadata", "added_to_torrents_list_at": "2024-06-01", "display_name": "B"},
            {"group_name": "other_group", "added_to_torrents_list_at": "2024-12-01", "display_name": "C"},
        ]
        with patch.object(tool, "get_torrents_json", return_value=mock_data):
            dumps = tool.get_metadata_dumps()
        assert len(dumps) == 2
        assert dumps[-1]["display_name"] == "B"

    def test_returns_empty_on_network_error(self):
        tool = AnnasArchiveTool()
        import requests
        with patch.object(tool, "get_torrents_json", side_effect=requests.ConnectionError):
            assert tool.get_metadata_dumps() == []

    def test_returns_empty_on_bad_json(self):
        tool = AnnasArchiveTool()
        with patch.object(tool, "get_torrents_json", side_effect=ValueError("bad json")):
            assert tool.get_metadata_dumps() == []
