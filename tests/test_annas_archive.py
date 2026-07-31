"""Tests for annas_archive_tool.py -- all network calls mocked."""

import hashlib
import http.server
import socketserver
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.annas_archive_tool import MD5_PATTERN, AnnasArchiveTool, DownloadMeta


@pytest.fixture(autouse=True)
def _offline_domain():
    """Keep these tests fully offline: AnnasArchiveTool.__init__ auto-detects the
    working domain over the network when no base_url is configured. Stub it so
    construction never makes a real request (and a bogus proxy can't time out).
    """
    with patch(
        "src.annas_archive_tool.get_working_domain",
        return_value="https://annas-archive.gl",
    ):
        yield


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
        with patch.object(tool._search_session, "get", return_value=mock_resp):
            link = tool.get_slow_download_link("72a7e9cb2b7a5c9d03f6ae095745a1fa")
        assert link == "https://annas-archive.gl/slow_download/abc123/0"

    def test_returns_none_on_invalid_md5(self):
        tool = AnnasArchiveTool()
        assert tool.get_slow_download_link("bad-hash") is None

    def test_returns_none_on_network_error(self):
        tool = AnnasArchiveTool()
        import requests

        with patch.object(tool._search_session, "get", side_effect=requests.ConnectionError("timeout")):
            assert tool.get_slow_download_link("72a7e9cb2b7a5c9d03f6ae095745a1fa") is None

    def test_rejects_untrusted_domain(self):
        tool = AnnasArchiveTool()
        html = '<html><body><a href="https://evil.com/slow_download/abc123">Download</a></body></html>'
        mock_resp = MagicMock()
        mock_resp.text = html
        mock_resp.raise_for_status = MagicMock()
        with patch.object(tool._search_session, "get", return_value=mock_resp):
            link = tool.get_slow_download_link("72a7e9cb2b7a5c9d03f6ae095745a1fa")
        assert link is None


class TestGetMetadataDumps:
    def test_returns_sorted_dumps(self):
        tool = AnnasArchiveTool()
        mock_data = [
            {
                "group_name": "aa_derived_mirror_metadata",
                "added_to_torrents_list_at": "2024-01-01",
                "display_name": "A",
            },
            {
                "group_name": "aa_derived_mirror_metadata",
                "added_to_torrents_list_at": "2024-06-01",
                "display_name": "B",
            },
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


class TestCurlCffiExceptionHandling:
    """curl_cffi exceptions do NOT subclass requests' — they must still be caught."""

    def test_get_slow_download_link_catches_curl_cffi_error(self):
        cffi_exc = pytest.importorskip("curl_cffi.requests.exceptions")
        tool = AnnasArchiveTool()
        with patch.object(tool._search_session, "get", side_effect=cffi_exc.RequestException("boom")):
            assert tool.get_slow_download_link("72a7e9cb2b7a5c9d03f6ae095745a1fa") is None


class TestResumeWhenServerIgnoresRange:
    """Regression: 200 full body + existing .part must rewrite, not append."""

    def test_range_ignored_200_rewrites_part_and_completes(self, tmp_path: Path) -> None:
        payload = b"FULL-FILE-CONTENT-ABCDEFGH" * 40
        md5 = hashlib.md5(payload).hexdigest()
        prefix = payload[:12]

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler API
                # Always ignore Range — classic CDN misbehaviour.
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format, *args):
                return

        httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            part_path = tmp_path / f"{md5}.file.part"
            final_path = tmp_path / f"{md5}.file"
            part_path.write_bytes(prefix)

            tool = AnnasArchiveTool(base_url="https://annas-archive.gl")
            meta = DownloadMeta(
                download_url=f"http://127.0.0.1:{port}/file",
                cookies={},
                user_agent="test-agent",
                slow_link=f"http://127.0.0.1:{port}/slow",
                timestamp=time.time(),
            )
            result = tool._attempt_download(
                meta=meta,
                md5=md5,
                part_path=str(part_path),
                final_path=str(final_path),
                filename=f"{md5}.file",
                output_dir=str(tmp_path),
                cancel=None,
            )
            assert result is not None
            assert Path(result).read_bytes() == payload
            assert not part_path.exists()
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_partial_content_206_appends_from_offset(self, tmp_path: Path) -> None:
        payload = b"0123456789ABCDEFGHIJ" * 8
        md5 = hashlib.md5(payload).hexdigest()
        existing = payload[:16]
        remainder = payload[16:]
        progress_events: list[tuple[int, int]] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler API
                rng = self.headers.get("Range", "")
                if rng.startswith("bytes="):
                    start = int(rng.split("=")[1].split("-")[0])
                    body = payload[start:]
                    self.send_response(206)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header(
                        "Content-Range",
                        f"bytes {start}-{len(payload) - 1}/{len(payload)}",
                    )
                else:
                    body = payload
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                return

        httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            part_path = tmp_path / f"{md5}.file.part"
            final_path = tmp_path / f"{md5}.file"
            part_path.write_bytes(existing)
            assert len(remainder) > 0

            tool = AnnasArchiveTool(
                base_url="https://annas-archive.gl",
                on_progress=lambda d, t: progress_events.append((d, t)),
            )
            meta = DownloadMeta(
                download_url=f"http://127.0.0.1:{port}/file",
                cookies={},
                user_agent="test-agent",
                slow_link=f"http://127.0.0.1:{port}/slow",
                timestamp=time.time(),
            )
            result = tool._attempt_download(
                meta=meta,
                md5=md5,
                part_path=str(part_path),
                final_path=str(final_path),
                filename=f"{md5}.file",
                output_dir=str(tmp_path),
                cancel=None,
            )
            assert result is not None
            assert Path(result).read_bytes() == payload
            # Progress totals: offset + remainder = full size (not remainder alone).
            assert progress_events
            assert all(t == len(payload) for _, t in progress_events)
            assert progress_events[0][0] >= len(existing)
            assert progress_events[-1][0] == len(payload)
            size_sidecar = Path(str(part_path) + ".size")
            # Sidecar may remain after rename of .part; total must match full file.
            if size_sidecar.exists():
                assert size_sidecar.read_text().strip() == str(len(payload))
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_range_ignored_200_progress_total_is_full_body(self, tmp_path: Path) -> None:
        """200 rewrite: progress total is Content-Length, not prefix+full."""
        payload = b"REWRITE-BODY-BYTES-XYZ" * 20
        md5 = hashlib.md5(payload).hexdigest()
        prefix = payload[:10]
        progress_events: list[tuple[int, int]] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler API
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format, *args):
                return

        httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            part_path = tmp_path / f"{md5}.file.part"
            final_path = tmp_path / f"{md5}.file"
            part_path.write_bytes(prefix)

            tool = AnnasArchiveTool(
                base_url="https://annas-archive.gl",
                on_progress=lambda d, t: progress_events.append((d, t)),
            )
            meta = DownloadMeta(
                download_url=f"http://127.0.0.1:{port}/file",
                cookies={},
                user_agent="test-agent",
                slow_link=f"http://127.0.0.1:{port}/slow",
                timestamp=time.time(),
            )
            result = tool._attempt_download(
                meta=meta,
                md5=md5,
                part_path=str(part_path),
                final_path=str(final_path),
                filename=f"{md5}.file",
                output_dir=str(tmp_path),
                cancel=None,
            )
            assert result is not None
            assert Path(result).read_bytes() == payload
            assert progress_events
            # Must not report prefix+full as total (old bug: existing_size + CL).
            corrupt_total = len(prefix) + len(payload)
            assert all(t == len(payload) for _, t in progress_events)
            assert all(t != corrupt_total for _, t in progress_events)
            assert progress_events[-1][0] == len(payload)
            # Rewrite starts at 0 — first reported downloaded must not include old prefix.
            assert progress_events[0][0] <= len(payload)
            assert progress_events[0][0] < corrupt_total
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_416_falls_through_to_md5_when_part_complete(self, tmp_path: Path) -> None:
        """416 Range Not Satisfiable: skip body write, MD5-verify existing .part."""
        payload = b"ALREADY-COMPLETE-PART-CONTENT!!" * 12
        md5 = hashlib.md5(payload).hexdigest()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler API
                # Server refuses further range — partial is already the full object.
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(payload)}")
                self.end_headers()

            def log_message(self, format, *args):
                return

        httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            part_path = tmp_path / f"{md5}.file.part"
            final_path = tmp_path / f"{md5}.file"
            part_path.write_bytes(payload)

            tool = AnnasArchiveTool(base_url="https://annas-archive.gl")
            meta = DownloadMeta(
                download_url=f"http://127.0.0.1:{port}/file",
                cookies={},
                user_agent="test-agent",
                slow_link=f"http://127.0.0.1:{port}/slow",
                timestamp=time.time(),
            )
            result = tool._attempt_download(
                meta=meta,
                md5=md5,
                part_path=str(part_path),
                final_path=str(final_path),
                filename=f"{md5}.file",
                output_dir=str(tmp_path),
                cancel=None,
            )
            assert result is not None
            assert Path(result).read_bytes() == payload
            assert not part_path.exists()
        finally:
            httpd.shutdown()
            httpd.server_close()
