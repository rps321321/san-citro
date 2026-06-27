"""Tests for CLI argument parsing, command wiring, and the C4 error boundary."""
from unittest.mock import patch, MagicMock

import pytest

from src.cli import main


_BASE_CONFIG = {"out_dir": "downloads", "proxies": [], "concurrency": 2, "history_db": None}


class TestArgParser:
    """Verify that the argument parser accepts all expected commands and flags."""

    def test_should_accept_diagnose_command(self):
        with patch("sys.argv", ["cli", "diagnose"]), \
             patch("src.cli.run_diagnostics") as mock_diag, \
             patch("src.cli.get_config", return_value=dict(_BASE_CONFIG)), \
             patch("src.cli.init_downloads_table"), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            mock_diag.assert_called_once()

    def test_should_accept_history_command(self):
        with patch("sys.argv", ["cli", "history", "-n", "5"]), \
             patch("src.cli.print_download_history") as mock_hist, \
             patch("src.cli.get_config", return_value=dict(_BASE_CONFIG)), \
             patch("src.cli.init_downloads_table"), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            mock_hist.assert_called_once()
            assert mock_hist.call_args.kwargs["limit"] == 5

    def test_should_reject_unknown_command(self):
        with patch("sys.argv", ["cli", "bogus-command"]), \
             patch("src.cli.get_config", return_value=dict(_BASE_CONFIG)), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit):
                main()

    def test_should_require_a_subcommand(self):
        with patch("sys.argv", ["cli"]), \
             patch("src.cli.get_config", return_value=dict(_BASE_CONFIG)), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit):
                main()

    def test_should_accept_verbose_flag(self):
        with patch("sys.argv", ["cli", "--verbose", "diagnose"]), \
             patch("src.cli.run_diagnostics"), \
             patch("src.cli.get_config", return_value=dict(_BASE_CONFIG)), \
             patch("src.cli.init_downloads_table"), \
             patch("src.cli.setup_logging", return_value=MagicMock()) as mock_log:
            main()
            mock_log.assert_called_once_with(verbose=True)


class TestErrorBoundary:
    """C4: the try/except boundary lives inside main() so `python -m src` shares it."""

    def test_should_exit_130_on_keyboard_interrupt(self):
        with patch("sys.argv", ["cli", "diagnose"]), \
             patch("src.cli._dispatch", side_effect=KeyboardInterrupt), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit) as exc:
                main()
            assert exc.value.code == 130

    def test_should_exit_1_on_scraper_runtime_error(self):
        with patch("sys.argv", ["cli", "search", "python"]), \
             patch("src.cli._dispatch", side_effect=RuntimeError("Failed to reach Anna's Archive")), \
             patch("src.cli.console") as mock_console, \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit) as exc:
                main()
            assert exc.value.code == 1
            assert "Error" in str(mock_console.print.call_args)

    def test_should_exit_1_on_unexpected_exception(self):
        with patch("sys.argv", ["cli", "diagnose"]), \
             patch("src.cli._dispatch", side_effect=ValueError("boom")), \
             patch("src.cli.console"), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit) as exc:
                main()
            assert exc.value.code == 1

    def test_should_propagate_systemexit_unchanged(self):
        """argparse / explicit sys.exit must NOT be swallowed by the boundary."""
        with patch("sys.argv", ["cli", "diagnose"]), \
             patch("src.cli._dispatch", side_effect=SystemExit(2)), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit) as exc:
                main()
            assert exc.value.code == 2


class TestDownloadCommand:
    """The download command validates the MD5 and delegates to the concurrent runner."""

    def test_should_reject_invalid_md5(self):
        with patch("sys.argv", ["cli", "download", "not-a-real-md5"]), \
             patch("src.cli.AnnasArchiveTool", return_value=MagicMock()), \
             patch("src.cli.create_strategy", return_value=MagicMock()), \
             patch("src.cli.get_config", return_value=dict(_BASE_CONFIG)), \
             patch("src.cli.init_downloads_table"), \
             patch("src.cli.console"), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit) as exc:
                main()
            assert exc.value.code == 1

    @patch("src.cli.AnnasArchiveTool")
    @patch("src.cli._run_concurrent_downloads", return_value=[])
    @patch("src.cli._print_summary_table")
    def test_should_force_concurrency_1_for_single_download(self, mock_table, mock_run, mock_tool_cls):
        mock_tool_cls.return_value = MagicMock()
        cfg = dict(_BASE_CONFIG, concurrency=7)
        with patch("src.cli.get_config", return_value=cfg), \
             patch("src.cli.init_downloads_table"), \
             patch("src.cli.create_strategy", return_value=MagicMock()), \
             patch("src.cli.setup_logging", return_value=MagicMock()), \
             patch("sys.argv", ["prog", "--concurrency", "5", "download", "aa" * 16]):
            main()
        mock_run.assert_called_once()
        # concurrency is the 6th positional arg; single downloads force it to 1.
        assert mock_run.call_args[0][5] == 1
