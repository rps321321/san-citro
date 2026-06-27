"""Tests for the graceful shutdown module."""

import signal
from unittest.mock import MagicMock, patch

import pytest

import src.shutdown as shutdown_mod
from src.shutdown import (
    _cancel_event,
    _signal_handler,
    install_signal_handlers,
    is_cancelled,
    register_driver,
    request_shutdown,
    unregister_driver,
)


@pytest.fixture(autouse=True)
def reset_shutdown_state():
    """Reset global shutdown state before each test."""
    _cancel_event.clear()
    shutdown_mod._shutdown_requested.clear()
    shutdown_mod._active_driver = None
    yield
    _cancel_event.clear()
    shutdown_mod._shutdown_requested.clear()
    shutdown_mod._active_driver = None


class TestIsCancelled:
    def test_should_return_false_when_no_shutdown_requested(self):
        assert is_cancelled() is False

    def test_should_return_true_after_request_shutdown(self):
        request_shutdown()
        assert is_cancelled() is True


class TestSignalHandler:
    def test_should_set_cancel_event_on_first_signal(self):
        _signal_handler(signal.SIGINT, None)
        assert is_cancelled() is True
        assert shutdown_mod._shutdown_requested.is_set() is True

    def test_should_force_exit_on_second_signal(self):
        # First signal
        _signal_handler(signal.SIGINT, None)

        # Second signal should call os._exit
        with patch("src.shutdown.os._exit") as mock_exit:
            _signal_handler(signal.SIGINT, None)
            mock_exit.assert_called_once_with(1)


class TestDriverRegistration:
    def test_should_register_and_unregister_driver(self):
        mock_driver = MagicMock()
        register_driver(mock_driver)
        assert shutdown_mod._active_driver is mock_driver

        unregister_driver()
        assert shutdown_mod._active_driver is None

    def test_should_quit_driver_on_forced_exit(self):
        mock_driver = MagicMock()
        register_driver(mock_driver)

        # First signal
        _signal_handler(signal.SIGINT, None)

        # Second signal -- driver.quit() should be called before os._exit
        with patch("src.shutdown.os._exit"):
            _signal_handler(signal.SIGINT, None)
        mock_driver.quit.assert_called_once()

    def test_should_handle_driver_quit_exception_gracefully(self):
        mock_driver = MagicMock()
        mock_driver.quit.side_effect = Exception("Chrome already dead")
        register_driver(mock_driver)

        # First signal
        _signal_handler(signal.SIGINT, None)

        # Second signal -- should not raise despite driver.quit() failing
        with patch("src.shutdown.os._exit"):
            _signal_handler(signal.SIGINT, None)


class TestInstallSignalHandlers:
    def test_should_install_sigint_handler(self):
        with patch("src.shutdown.signal.signal") as mock_signal:
            with patch("src.shutdown.atexit.register"):
                install_signal_handlers()
            # SIGINT should always be registered
            calls = [c[0][0] for c in mock_signal.call_args_list]
            assert signal.SIGINT in calls

    def test_should_register_atexit_handler(self):
        with patch("src.shutdown.signal.signal"):
            with patch("src.shutdown.atexit.register") as mock_atexit:
                install_signal_handlers()
            mock_atexit.assert_called_once()
