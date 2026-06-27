"""Tests for config_manager.py."""

import json
from unittest.mock import patch

from src import config_manager


class TestGetConfig:
    def test_returns_defaults_when_no_file(self, tmp_path):
        fake_path = tmp_path / "nonexistent.json"
        with (
            patch.object(config_manager, "get_config_path", return_value=fake_path),
            patch.object(config_manager, "_migrate_legacy_config"),
        ):
            cfg = config_manager.get_config()
        assert "db_path" not in cfg
        assert cfg["out_dir"] == "downloads"
        assert cfg["concurrency"] == 2
        assert cfg["proxies"] == []

    def test_loads_existing_config(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"concurrency": 4}))
        with (
            patch.object(config_manager, "get_config_path", return_value=cfg_file),
            patch.object(config_manager, "_migrate_legacy_config"),
        ):
            cfg = config_manager.get_config()
        assert cfg["concurrency"] == 4
        assert cfg["out_dir"] == "downloads"  # default merged

    def test_returns_defaults_on_corrupt_json(self, tmp_path):
        cfg_file = tmp_path / "bad.json"
        cfg_file.write_text("NOT VALID JSON{{{")
        with (
            patch.object(config_manager, "get_config_path", return_value=cfg_file),
            patch.object(config_manager, "_migrate_legacy_config"),
        ):
            cfg = config_manager.get_config()
        assert "db_path" not in cfg  # defaults returned


class TestSaveConfig:
    def test_saves_and_reads_back(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        with (
            patch.object(config_manager, "get_config_path", return_value=cfg_file),
            patch.object(config_manager, "_migrate_legacy_config"),
        ):
            config_manager.save_config(out_dir="/new/downloads")
            cfg = config_manager.get_config()
        assert cfg["out_dir"] == "/new/downloads"

    def test_none_values_dont_overwrite(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"out_dir": "out", "concurrency": 2, "proxies": []}))
        with (
            patch.object(config_manager, "get_config_path", return_value=cfg_file),
            patch.object(config_manager, "_migrate_legacy_config"),
        ):
            config_manager.save_config(concurrency=8)
            cfg = config_manager.get_config()
        assert cfg["out_dir"] == "out"
        assert cfg["concurrency"] == 8

    def test_zero_concurrency_is_saved(self, tmp_path):
        """Regression: old code used truthiness check, blocking concurrency=0."""
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"out_dir": "out", "concurrency": 4, "proxies": []}))
        with (
            patch.object(config_manager, "get_config_path", return_value=cfg_file),
            patch.object(config_manager, "_migrate_legacy_config"),
        ):
            config_manager.save_config(concurrency=0)
            cfg = config_manager.get_config()
        assert cfg["concurrency"] == 0
