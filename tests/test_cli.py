"""Tests for CLI argument parsing and command wiring."""
import json
import sqlite3
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from src.cli import main, _handle_init, _handle_ingest, _handle_stats


class TestArgParser:
    """Verify that the argument parser accepts all expected commands and flags."""

    def test_should_accept_init_command(self):
        with patch("sys.argv", ["cli", "init"]), \
             patch("src.cli._handle_init") as mock_init, \
             patch("src.cli.get_config", return_value={"db_path": None, "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            mock_init.assert_called_once()

    def test_should_accept_stats_command(self):
        with patch("sys.argv", ["cli", "stats"]), \
             patch("src.cli._handle_stats") as mock_stats, \
             patch("src.cli.get_config", return_value={"db_path": "/tmp/test.db", "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            mock_stats.assert_called_once_with("/tmp/test.db")

    def test_should_accept_ingest_with_zst_file(self):
        with patch("sys.argv", ["cli", "ingest", "data.zst"]), \
             patch("src.cli._handle_ingest") as mock_ingest, \
             patch("src.cli.get_config", return_value={"db_path": None, "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            mock_ingest.assert_called_once()
            call_args = mock_ingest.call_args[0][0]
            assert call_args.zst_file == "data.zst"
            assert call_args.db_path is None

    def test_should_accept_ingest_with_db_flag(self):
        with patch("sys.argv", ["cli", "ingest", "data.zst", "--db", "/tmp/my.db"]), \
             patch("src.cli._handle_ingest") as mock_ingest, \
             patch("src.cli.get_config", return_value={"db_path": None, "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            call_args = mock_ingest.call_args[0][0]
            assert call_args.zst_file == "data.zst"
            assert call_args.db_path == "/tmp/my.db"

    def test_should_accept_diagnose_command(self):
        with patch("sys.argv", ["cli", "diagnose"]), \
             patch("src.cli.run_diagnostics") as mock_diag, \
             patch("src.cli.get_config", return_value={"db_path": None, "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            mock_diag.assert_called_once()

    def test_should_accept_optimize_command(self):
        with patch("sys.argv", ["cli", "optimize"]), \
             patch("src.cli.optimize_db") as mock_opt, \
             patch("src.cli.get_config", return_value={"db_path": "/tmp/test.db", "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            main()
            mock_opt.assert_called_once_with("/tmp/test.db")

    def test_should_reject_refresh_proxies_command(self):
        """refresh-proxies was removed since there is no proxy-fetching logic."""
        with patch("sys.argv", ["cli", "refresh-proxies"]), \
             patch("src.cli.get_config", return_value={"db_path": None, "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()):
            with pytest.raises(SystemExit):
                main()

    def test_should_accept_verbose_flag(self):
        with patch("sys.argv", ["cli", "--verbose", "stats"]), \
             patch("src.cli._handle_stats"), \
             patch("src.cli.get_config", return_value={"db_path": "/tmp/t.db", "out_dir": "downloads", "proxies": []}), \
             patch("src.cli.setup_logging", return_value=MagicMock()) as mock_log:
            main()
            mock_log.assert_called_once_with(verbose=True)


class TestHandleInit:
    """Test the init wizard handler."""

    def test_should_save_user_provided_paths(self, tmp_path):
        config = {"db_path": None, "out_dir": "downloads"}
        with patch("src.cli.console") as mock_console, \
             patch("src.cli.save_config") as mock_save:
            mock_console.input = MagicMock(side_effect=["/tmp/my.db", "/tmp/out"])
            _handle_init(config)
            mock_save.assert_called_once_with(db_path="/tmp/my.db", out_dir="/tmp/out")

    def test_should_keep_defaults_when_user_presses_enter(self):
        config = {"db_path": "/existing/db.sqlite", "out_dir": "dl"}
        with patch("src.cli.console") as mock_console, \
             patch("src.cli.save_config") as mock_save:
            mock_console.input = MagicMock(side_effect=["", ""])
            _handle_init(config)
            mock_save.assert_called_once_with(db_path="/existing/db.sqlite", out_dir="dl")


class TestHandleIngest:
    """Test the ingest command handler."""

    def test_should_exit_when_no_db_path(self):
        args = MagicMock()
        args.db_path = None
        args.zst_file = "data.zst"
        config = {"db_path": None}
        with pytest.raises(SystemExit):
            _handle_ingest(args, config)

    def test_should_exit_when_zst_file_missing(self, tmp_path):
        args = MagicMock()
        args.db_path = str(tmp_path / "test.db")
        args.zst_file = str(tmp_path / "nonexistent.zst")
        config = {"db_path": None}
        with pytest.raises(SystemExit):
            _handle_ingest(args, config)

    def test_should_ingest_and_save_config(self, tmp_path, mock_zst_file):
        db_path = str(tmp_path / "ingested.db")
        args = MagicMock()
        args.db_path = db_path
        args.zst_file = str(mock_zst_file)
        config = {"db_path": None}

        with patch("src.cli.save_config") as mock_save:
            _handle_ingest(args, config)
            mock_save.assert_called_once_with(db_path=db_path)

        # Verify records were ingested
        with sqlite3.connect(db_path) as conn:
            count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        assert count == 5

    def test_should_use_config_db_path_when_no_flag(self, tmp_path, mock_zst_file):
        db_path = str(tmp_path / "from_config.db")
        args = MagicMock()
        args.db_path = None
        args.zst_file = str(mock_zst_file)
        config = {"db_path": db_path}

        with patch("src.cli.save_config"):
            _handle_ingest(args, config)

        with sqlite3.connect(db_path) as conn:
            count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        assert count == 5


class TestHandleStats:
    """Test the stats command handler."""

    def test_should_warn_when_no_db_configured(self, capsys):
        with patch("src.cli.console") as mock_console:
            _handle_stats(None)
            mock_console.print.assert_called_once()
            call_str = str(mock_console.print.call_args)
            assert "No database configured" in call_str

    def test_should_warn_when_db_file_missing(self):
        with patch("src.cli.console") as mock_console:
            _handle_stats("/nonexistent/path.db")
            call_str = str(mock_console.print.call_args)
            assert "No database configured" in call_str

    def test_should_display_stats_for_populated_db(self, test_db):
        with patch("src.cli.console") as mock_console:
            _handle_stats(str(test_db))
            # Should have been called multiple times (header + stats lines + tables)
            assert mock_console.print.call_count >= 4
            # Check the string-based calls contain expected data
            str_calls = [
                str(c) for c in mock_console.print.call_args_list
                if not str(c).startswith("call(<rich.table")
            ]
            all_output = " ".join(str_calls)
            assert "5" in all_output  # 5 records from mock data
            # Tables are Rich objects; verify they were printed (2 tables: extensions + languages)
            table_calls = [
                c for c in mock_console.print.call_args_list
                if "rich.table.Table" in str(c)
            ]
            assert len(table_calls) == 2

    def test_should_display_stats_for_empty_db(self, empty_db):
        with patch("src.cli.console") as mock_console:
            _handle_stats(str(empty_db))
            assert mock_console.print.call_count >= 4
            all_output = " ".join(str(c) for c in mock_console.print.call_args_list)
            assert "0" in all_output
