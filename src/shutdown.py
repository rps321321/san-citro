"""Graceful shutdown handling for SIGINT (Ctrl+C) and SIGTERM.

First signal sets a cancellation flag and prints a message.
Second signal forces immediate exit.
An atexit handler ensures Chrome processes are cleaned up.
"""

import atexit
import os
import signal
import sys
import threading
from typing import Optional

from .logger import get_logger

logger = get_logger()

# Global cancellation event — checked by long-running loops
_cancel_event = threading.Event()

# Track whether we already received a shutdown signal (thread-safe)
_shutdown_requested = threading.Event()

# Track the active Chrome driver so atexit can clean it up
_active_driver: Optional[object] = None
_driver_lock = threading.Lock()


def is_shutdown_requested() -> bool:
    """Return True if a shutdown signal has already been received."""
    return _shutdown_requested.is_set()


def is_cancelled() -> bool:
    """Return True if a graceful shutdown has been requested."""
    return _cancel_event.is_set()


def request_shutdown() -> None:
    """Programmatically request a graceful shutdown (for testing)."""
    _cancel_event.set()


def register_driver(driver: object) -> None:
    """Register a Chrome driver instance for cleanup on exit."""
    global _active_driver
    with _driver_lock:
        _active_driver = driver


def unregister_driver() -> None:
    """Unregister the Chrome driver after normal cleanup."""
    global _active_driver
    with _driver_lock:
        _active_driver = None


def _quit_driver_safe() -> None:
    """Attempt to quit the registered Chrome driver, ignoring errors."""
    global _active_driver
    with _driver_lock:
        driver = _active_driver
        _active_driver = None
    if driver is not None:
        try:
            driver.quit()
        except Exception:
            pass


def _signal_handler(signum: int, frame: object) -> None:
    """Handle SIGINT/SIGTERM with two-stage shutdown.

    First call: set cancellation flag, print message, let loops exit cleanly.
    Second call: force-exit immediately.
    """
    if _shutdown_requested.is_set():
        # Second signal — force exit
        print("\nForce quitting...", file=sys.stderr, flush=True)
        _quit_driver_safe()
        os._exit(1)

    _shutdown_requested.set()
    _cancel_event.set()
    print("\nShutting down gracefully... (press Ctrl+C again to force quit)", file=sys.stderr, flush=True)
    logger.info("Shutdown requested by signal")


def _atexit_cleanup() -> None:
    """Last-resort cleanup registered via atexit."""
    _quit_driver_safe()


def install_signal_handlers() -> None:
    """Install SIGINT and SIGTERM handlers and register atexit cleanup.

    Call this once at program startup (from cli.main).
    On Windows, SIGTERM may not be available — we handle that gracefully.
    """
    signal.signal(signal.SIGINT, _signal_handler)
    try:
        signal.signal(signal.SIGTERM, _signal_handler)
    except (OSError, ValueError):
        # SIGTERM not available on some platforms (Windows)
        pass

    atexit.register(_atexit_cleanup)
