"""Tests for logger.py."""
import logging
from pathlib import Path

import pytest

from src.logger import setup_logging, get_logger


class TestSetupLogging:
    def test_returns_logger(self, tmp_path):
        log_file = str(tmp_path / "test.log")
        logger = setup_logging(verbose=False, log_file=log_file)
        assert isinstance(logger, logging.Logger)
        assert logger.name == "annas_archive"

    def test_verbose_sets_debug_level(self, tmp_path):
        log_file = str(tmp_path / "test.log")
        logger = setup_logging(verbose=True, log_file=log_file)
        # Console handler should be DEBUG
        console_handlers = [h for h in logger.handlers if not hasattr(h, "maxBytes")]
        assert any(h.level == logging.DEBUG for h in console_handlers)

    def test_log_file_created(self, tmp_path):
        log_file = str(tmp_path / "test.log")
        logger = setup_logging(log_file=log_file)
        logger.info("Test message")
        assert Path(log_file).exists()

    def test_no_crash_on_unwritable_log_path(self, tmp_path):
        # Non-existent deep path
        log_file = str(tmp_path / "nonexistent" / "deep" / "test.log")
        logger = setup_logging(log_file=log_file)
        # Should still work (console-only fallback)
        logger.info("This should not crash")


class TestGetLogger:
    def test_returns_named_logger(self):
        logger = get_logger()
        assert logger.name == "annas_archive"
