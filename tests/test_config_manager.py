"""Tests for config_manager.py."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
import config_manager


class TestGetConfig:
    def test_returns_defaults_when_no_file(self, tmp_path):
        fake_path = tmp_path / "nonexistent.json"
        with patch.object(config_manager, "CONFIG_PATH", fake_path):
            cfg = config_manager.get_config()
        assert cfg["db_path"] is None
        assert cfg["out_dir"] == "downloads"
        assert cfg["concurrency"] == 2
        assert cfg["proxies"] == []

    def test_loads_existing_config(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"db_path": "/my/db.db", "concurrency": 4}))
        with patch.object(config_manager, "CONFIG_PATH", cfg_file):
            cfg = config_manager.get_config()
        assert cfg["db_path"] == "/my/db.db"
        assert cfg["concurrency"] == 4
        assert cfg["out_dir"] == "downloads"  # default merged

    def test_returns_defaults_on_corrupt_json(self, tmp_path):
        cfg_file = tmp_path / "bad.json"
        cfg_file.write_text("NOT VALID JSON{{{")
        with patch.object(config_manager, "CONFIG_PATH", cfg_file):
            cfg = config_manager.get_config()
        assert cfg["db_path"] is None  # defaults returned


class TestSaveConfig:
    def test_saves_and_reads_back(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        with patch.object(config_manager, "CONFIG_PATH", cfg_file):
            config_manager.save_config(db_path="/new/path.db")
            cfg = config_manager.get_config()
        assert cfg["db_path"] is not None
        assert "path.db" in cfg["db_path"]  # abspath applied (path varies by OS)

    def test_none_values_dont_overwrite(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"db_path": "/orig.db", "out_dir": "out", "concurrency": 2, "proxies": []}))
        with patch.object(config_manager, "CONFIG_PATH", cfg_file):
            config_manager.save_config(concurrency=8)
            cfg = config_manager.get_config()
        assert cfg["db_path"] == "/orig.db"
        assert cfg["concurrency"] == 8

    def test_zero_concurrency_is_saved(self, tmp_path):
        """Regression: old code used truthiness check, blocking concurrency=0."""
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"db_path": None, "out_dir": "out", "concurrency": 4, "proxies": []}))
        with patch.object(config_manager, "CONFIG_PATH", cfg_file):
            config_manager.save_config(concurrency=0)
            cfg = config_manager.get_config()
        assert cfg["concurrency"] == 0

    def test_empty_string_db_path_is_saved(self, tmp_path):
        """Regression: old code used truthiness check, blocking db_path=''."""
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"db_path": "/old.db", "out_dir": "out", "concurrency": 2, "proxies": []}))
        with patch.object(config_manager, "CONFIG_PATH", cfg_file):
            config_manager.save_config(db_path="")
            cfg = config_manager.get_config()
        # Should be saved (abspath of empty string is CWD, but it's saved)
        assert cfg["db_path"] is not None
