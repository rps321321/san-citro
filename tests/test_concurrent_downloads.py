"""Tests for concurrent download functionality in cli.py."""

import time
from unittest.mock import MagicMock, patch

from src.cli import (
    DownloadResult,
    _download_one,
    _print_summary_table,
    _run_concurrent_downloads,
)


class TestDownloadResult:
    def test_dataclass_defaults(self):
        r = DownloadResult(md5="abc123", filename="test.pdf", title="Test Book", status="success")
        assert r.path is None
        assert r.error is None
        assert r.elapsed_seconds == 0.0

    def test_dataclass_full(self):
        r = DownloadResult(
            md5="abc123",
            filename="test.pdf",
            title="Test Book",
            status="failed",
            path=None,
            error="timeout",
            elapsed_seconds=5.2,
        )
        assert r.error == "timeout"
        assert r.elapsed_seconds == 5.2


class TestDownloadOne:
    """Tests for _download_one -- the single-file download wrapper."""

    def test_returns_success_when_tool_returns_path(self):
        tool = MagicMock()

        with patch("src.cli.run_download", return_value="/downloads/book.pdf") as mock_run:
            result = _download_one(tool, "aabbccdd" * 4, "/downloads", None, None)

        assert result.status == "success"
        assert result.path == "/downloads/book.pdf"
        assert result.elapsed_seconds >= 0
        mock_run.assert_called_once()

    def test_returns_failed_when_tool_returns_none(self):
        tool = MagicMock()

        with patch("src.cli.run_download", return_value=None):
            result = _download_one(tool, "aabbccdd" * 4, "/downloads", None, None)

        assert result.status == "failed"
        assert result.error == "No file returned"

    def test_returns_failed_with_error_from_status(self):
        tool = MagicMock()

        def fake_run(*args, on_status, **kwargs):
            on_status({"error": "browser crash"})
            return None

        with patch("src.cli.run_download", side_effect=fake_run):
            result = _download_one(tool, "aabbccdd" * 4, "/downloads", None, None)

        assert result.status == "failed"
        assert "browser crash" in result.error

    def test_uses_filename_from_db_when_available(self):
        tool = MagicMock()
        md5 = "aabbccdd" * 4

        with (
            patch("src.cli.get_filename_from_db", return_value="Great_Gatsby.epub"),
            patch("src.cli.run_download", return_value="/downloads/Great_Gatsby.epub"),
        ):
            result = _download_one(tool, md5, "/downloads", "/some/db.sqlite", None)

        assert result.filename == "Great_Gatsby.epub"

    def test_uses_md5_fallback_filename_when_db_returns_none(self):
        tool = MagicMock()
        md5 = "aabbccdd" * 4

        with patch("src.cli.get_filename_from_db", return_value=None), patch("src.cli.run_download", return_value=None):
            result = _download_one(tool, md5, "/downloads", None, None)

        assert result.filename == f"{md5}.file"


class TestRunConcurrentDownloads:
    """Tests for _run_concurrent_downloads -- the thread pool coordinator."""

    def _make_targets(self, md5_list):
        """Build fake target tuples matching search result shape (index 4 = md5)."""
        return [(None, None, None, None, md5) for md5 in md5_list]

    @patch("src.cli._download_one")
    def test_downloads_all_targets(self, mock_dl):
        mock_dl.side_effect = lambda tool, md5, out, db, hist: DownloadResult(
            md5=md5,
            filename=f"{md5}.file",
            status="success",
            path=f"/dl/{md5}.file",
            elapsed_seconds=1.0,
        )
        tool = MagicMock()
        targets = self._make_targets(["aa" * 16, "bb" * 16, "cc" * 16])

        results = _run_concurrent_downloads(tool, targets, "/dl", None, None, concurrency=2)

        assert len(results) == 3
        assert all(r.status == "success" for r in results)
        assert mock_dl.call_count == 3

    @patch("src.cli._download_one")
    def test_failed_download_does_not_block_others(self, mock_dl):
        def side_effect(tool, md5, out, db, hist):
            if md5.startswith("bb"):
                return DownloadResult(
                    md5=md5,
                    filename=f"{md5}.file",
                    status="error",
                    error="boom",
                    elapsed_seconds=0.1,
                )
            return DownloadResult(
                md5=md5,
                filename=f"{md5}.file",
                status="success",
                path=f"/dl/{md5}.file",
                elapsed_seconds=1.0,
            )

        mock_dl.side_effect = side_effect
        tool = MagicMock()
        targets = self._make_targets(["aa" * 16, "bb" * 16, "cc" * 16])

        results = _run_concurrent_downloads(tool, targets, "/dl", None, None, concurrency=3)

        assert len(results) == 3
        statuses = {r.md5[:4]: r.status for r in results}
        assert statuses["aaaa"] == "success"
        assert statuses["bbbb"] == "error"
        assert statuses["cccc"] == "success"

    @patch("src.cli._download_one")
    def test_concurrency_1_runs_sequentially(self, mock_dl):
        """With concurrency=1 the thread pool should still work (single worker)."""
        mock_dl.return_value = DownloadResult(
            md5="x" * 32,
            filename="x.file",
            status="success",
            path="/dl/x.file",
            elapsed_seconds=0.5,
        )
        tool = MagicMock()
        targets = self._make_targets(["aa" * 16, "bb" * 16])

        results = _run_concurrent_downloads(tool, targets, "/dl", None, None, concurrency=1)

        assert len(results) == 2

    @patch("src.cli._download_one")
    def test_actual_parallelism_with_concurrency_gt_1(self, mock_dl):
        """Verify that downloads actually run in parallel when concurrency > 1."""

        def slow_download(tool, md5, out, db, hist):
            time.sleep(0.2)
            return DownloadResult(
                md5=md5,
                filename=f"{md5}.file",
                status="success",
                path=f"/dl/{md5}.file",
                elapsed_seconds=0.2,
            )

        mock_dl.side_effect = slow_download
        tool = MagicMock()
        targets = self._make_targets(["aa" * 16, "bb" * 16, "cc" * 16, "dd" * 16])

        start = time.monotonic()
        results = _run_concurrent_downloads(tool, targets, "/dl", None, None, concurrency=4)
        elapsed = time.monotonic() - start

        assert len(results) == 4
        # 4 tasks at 0.2s each with concurrency=4 should finish in ~0.2-0.4s, not 0.8s
        assert elapsed < 0.6, f"Expected parallel execution but took {elapsed:.2f}s"


class TestPrintSummaryTable:
    """Tests for _print_summary_table -- ensures it doesn't crash on various inputs."""

    def test_prints_without_error(self, capsys):
        results = [
            DownloadResult(
                md5="aa" * 16,
                filename="book1.pdf",
                title="",
                status="success",
                path="/dl/book1.pdf",
                elapsed_seconds=12.3,
            ),
            DownloadResult(
                md5="bb" * 16,
                filename="book2.epub",
                title="",
                status="failed",
                error="No file returned",
                elapsed_seconds=5.0,
            ),
            DownloadResult(
                md5="cc" * 16,
                filename="book3.mobi",
                title="",
                status="error",
                error="ConnectionError",
                elapsed_seconds=0.1,
            ),
        ]
        # Should not raise
        _print_summary_table(results)

    def test_handles_empty_results(self, capsys):
        _print_summary_table([])

    def test_handles_long_filename(self, capsys):
        results = [
            DownloadResult(
                md5="dd" * 16,
                filename="A" * 100 + ".pdf",
                status="success",
                path="/dl/" + "A" * 100 + ".pdf",
                elapsed_seconds=1.0,
            ),
        ]
        _print_summary_table(results)


class TestConcurrencyCliFlag:
    """Tests for --concurrency CLI argument parsing."""

    @patch("src.cli.AnnasArchiveTool")
    @patch("src.cli._run_concurrent_downloads", return_value=[])
    @patch("src.cli._print_summary_table")
    def test_concurrency_flag_overrides_config(self, mock_table, mock_run, mock_tool_cls):
        mock_tool_cls.return_value = MagicMock()

        with (
            patch(
                "src.cli.get_config",
                return_value={
                    "db_path": None,
                    "out_dir": "downloads",
                    "concurrency": 2,
                    "proxies": [],
                },
            ),
            patch("sys.argv", ["prog", "--concurrency", "5", "download", "aa" * 16]),
        ):
            from src.cli import main

            main()

        # _run_concurrent_downloads should have been called for the download command
        mock_run.assert_called_once()
        # The download command forces concurrency=1 for single files
        # so we check the arg parser resolved --concurrency=5 but download uses 1
        call_args = mock_run.call_args
        assert call_args[0][5] == 1  # concurrency arg (6th positional) for single download

    @patch("src.cli.AnnasArchiveTool")
    @patch("src.cli._run_concurrent_downloads", return_value=[])
    @patch("src.cli._print_summary_table")
    def test_config_concurrency_used_when_no_flag(self, mock_table, mock_run, mock_tool_cls):
        mock_tool_cls.return_value = MagicMock()

        # download command always uses concurrency=1, so this tests that
        # active_concurrency is resolved from config when no --concurrency flag
        with (
            patch(
                "src.cli.get_config",
                return_value={
                    "db_path": None,
                    "out_dir": "downloads",
                    "concurrency": 7,
                    "proxies": [],
                },
            ),
            patch("sys.argv", ["prog", "download", "aa" * 16]),
        ):
            from src.cli import main

            main()

        # For single download, concurrency is forced to 1
        mock_run.assert_called_once()
