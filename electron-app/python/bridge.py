"""JSON-RPC bridge: reads newline-delimited JSON from stdin, dispatches to handlers.

Protocol
--------
Request:  {"id": N, "method": "...", "params": {...}}
Response: {"id": N, "result": ...}  or  {"id": N, "error": {"code": N, "message": "..."}}
Event:    {"event": "...", "data": {...}}   (no id -- fire-and-forget)

stderr is reserved for Python logging only (never protocol data).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from typing import Any

# ---------------------------------------------------------------------------
# Add the project root to sys.path so ``from src.xxx import ...`` works.
# Project root is two levels up from this file:
#   <project>/electron-app/python/bridge.py  ->  <project>/
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_THIS_DIR, os.pardir, os.pardir))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
# Also add the bridge directory itself so sibling modules (bridge_handlers,
# download_manager) can be imported by name.
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

# ---------------------------------------------------------------------------
# Logging -- all output goes to stderr so it never contaminates the protocol
# ---------------------------------------------------------------------------
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[bridge %(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("bridge")

# ---------------------------------------------------------------------------
# Thread-safe stdout writer
# ---------------------------------------------------------------------------
_write_lock = threading.Lock()

# Open stdout in binary mode for deterministic newline handling.
# On Windows, Python's text-mode stdout translates \n -> \r\n, which can
# corrupt the protocol when the Electron side expects a single \n delimiter.
if hasattr(sys.stdout, "buffer"):
    _stdout_bin = sys.stdout.buffer
else:
    _stdout_bin = sys.stdout  # type: ignore[assignment]


def _write_message(obj: dict[str, Any]) -> None:
    """Serialize *obj* as a single JSON line to stdout (thread-safe)."""
    payload = json.dumps(obj, default=str, ensure_ascii=False) + "\n"
    raw = payload.encode("utf-8")
    with _write_lock:
        _stdout_bin.write(raw)
        _stdout_bin.flush()


# ---------------------------------------------------------------------------
# Public helpers -- importable by handlers / download_manager
# ---------------------------------------------------------------------------


def send_response(
    request_id: int,
    result: Any = None,
    error: dict[str, Any] | None = None,
) -> None:
    """Send a JSON-RPC response for *request_id*."""
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    _write_message(msg)


def send_event(event_name: str, data: dict[str, Any]) -> None:
    """Emit a fire-and-forget event to the Electron renderer."""
    _write_message({"event": event_name, "data": data})


# ---------------------------------------------------------------------------
# Method registry + dispatch helpers
# ---------------------------------------------------------------------------

# Methods that are expensive and should run on a background thread.
_LONG_METHODS: set[str] = {"start_download", "run_diagnostics", "search"}

# Populated by bridge_handlers.register_handlers()
_handlers: dict[str, Any] = {}


def register_method(name: str, handler: Any) -> None:
    """Register a callable as a JSON-RPC method."""
    _handlers[name] = handler


def _dispatch(request_id: int, method: str, params: dict[str, Any]) -> None:
    """Look up *method* in the registry and call it."""
    handler = _handlers.get(method)
    if handler is None:
        send_response(
            request_id,
            error={
                "code": -32601,
                "message": f"Method not found: {method}",
            },
        )
        return

    try:
        result = handler(params)
        send_response(request_id, result=result)
    except Exception as exc:
        logger.exception("Handler %s raised an exception", method)
        send_response(
            request_id,
            error={
                "code": -32000,
                "message": f"{type(exc).__name__}: {exc}",
            },
        )


def _dispatch_threaded(request_id: int, method: str, params: dict[str, Any]) -> None:
    """Run *_dispatch* on a daemon thread for long-running methods."""
    t = threading.Thread(
        target=_dispatch,
        args=(request_id, method, params),
        daemon=True,
        name=f"rpc-{method}-{request_id}",
    )
    t.start()


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def main() -> None:
    """Read stdin line-by-line and dispatch JSON-RPC requests."""

    # When running as ``python bridge.py``, the module name is __main__.
    # Sibling modules do ``from bridge import ...``, so we must make this
    # module importable under the name "bridge" as well.
    this_module = sys.modules[__name__]
    if "bridge" not in sys.modules:
        sys.modules["bridge"] = this_module

    # Import handlers to populate the registry
    import bridge_handlers

    bridge_handlers.register_handlers()

    # Clean up downloads orphaned by a previous unclean shutdown
    try:
        from src.config_manager import get_config
        from src.download_history import cleanup_orphaned_downloads

        config = get_config()
        history_db = config.get("history_db")
        cleanup_orphaned_downloads(db_path=history_db)
    except Exception as exc:
        logger.warning("Could not clean up orphaned downloads: %s", exc)

    # Recover stuck audiobooks and sweep stale .tmp files from a previous run
    try:
        import audiobook_queue

        from src.config_manager import get_config as _get_config

        _out_dir = _get_config().get("out_dir", "")
        audiobook_queue.resweep(_out_dir)
    except Exception as exc:
        logger.warning("Could not resweep audiobook queue: %s", exc)

    logger.info("Bridge ready (project root: %s)", _PROJECT_ROOT)

    # Read from stdin in binary mode to match the binary stdout approach.
    stdin_bin = sys.stdin.buffer if hasattr(sys.stdin, "buffer") else sys.stdin

    for raw_line in stdin_bin:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            logger.warning("Invalid JSON on stdin: %s", str(exc)[:200])
            continue

        request_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {})

        if request_id is None or method is None:
            logger.warning("Malformed request (missing id or method): %s", line[:200])
            # Send error response if we have an id, so caller doesn't hang
            if request_id is not None:
                send_response(
                    request_id,
                    error={
                        "code": -32600,
                        "message": "Invalid request: missing method",
                    },
                )
            continue

        # Validate request_id type (JSON-RPC 2.0 requires string or number)
        if not isinstance(request_id, int | str):
            logger.warning("Invalid request id type: %s", type(request_id).__name__)
            continue

        logger.info("-> %s (id=%s)", method, request_id)

        # Handle quit before dispatch — break the loop for clean shutdown
        if method == "quit":
            send_response(request_id, result={"status": "ok"})
            logger.info("Received quit — exiting")
            break

        if method in _LONG_METHODS:
            _dispatch_threaded(request_id, method, params)
        else:
            _dispatch(request_id, method, params)

    logger.info("stdin closed -- bridge exiting")


if __name__ == "__main__":
    main()
