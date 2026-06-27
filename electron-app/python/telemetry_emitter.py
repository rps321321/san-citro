"""Fire-and-forget telemetry emitter for the JSON-RPC bridge.

Renderer-owned identity + Supabase creds are threaded in via ``set_context``.
``emit`` enriches a row with that context and POSTs it to the Supabase REST
endpoint on a daemon thread.  All network I/O is best-effort: failures are
logged at debug and swallowed so telemetry can never break a handler/worker.

Uses stdlib ``urllib.request`` only -- never requests/curl_cffi.
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.request
from typing import Any

logger = logging.getLogger("bridge.telemetry")

# Module-level context guarded by a lock.  Empty until set_context() runs.
_lock = threading.Lock()
_context: dict[str, str] = {
    "device_id": "",
    "session_id": "",
    "app_version": "",
    "supabase_url": "",
    "anon_key": "",
}


def set_context(
    device_id: str,
    session_id: str,
    app_version: str,
    supabase_url: str,
    anon_key: str,
) -> None:
    """Store the renderer-owned identity + Supabase creds for later emits."""
    with _lock:
        _context["device_id"] = device_id
        _context["session_id"] = session_id
        _context["app_version"] = app_version
        _context["supabase_url"] = supabase_url
        _context["anon_key"] = anon_key


def _post(url: str, anon_key: str, body: bytes) -> None:
    """POST *body* to *url* (runs on a daemon thread; swallows everything)."""
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "apikey": anon_key,
            "Authorization": "Bearer " + anon_key,
            "Prefer": "return=minimal",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception as exc:
        logger.debug("telemetry POST failed: %s", exc)


def emit(table: str, row: dict[str, Any]) -> None:
    """Enrich *row* with context and POST it to Supabase (fire-and-forget).

    No-op when context is unset (empty url/key).  Returns immediately; the
    actual POST happens on a daemon thread.  Never raises to the caller.
    """
    with _lock:
        supabase_url = _context["supabase_url"]
        anon_key = _context["anon_key"]
        if not supabase_url or not anon_key:
            return
        enriched: dict[str, Any] = {
            "session_id": _context["session_id"],
            "device_id": _context["device_id"],
            "app_version": _context["app_version"],
            **row,
        }

    try:
        url = supabase_url + "/rest/v1/" + table
        body = json.dumps([enriched]).encode()
        threading.Thread(
            target=_post,
            args=(url, anon_key, body),
            daemon=True,
            name=f"telemetry-{table}",
        ).start()
    except Exception as exc:
        logger.debug("telemetry emit failed: %s", exc)


if __name__ == "__main__":
    # ponytail one-check: empty creds -> emit is a silent no-op (no network).
    set_context("", "", "", "", "")
    emit("x", {"a": 1})
    print("ok: emit with empty context returned without raising")
