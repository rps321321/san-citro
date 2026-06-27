"""JSON-RPC method handlers for the Electron bridge.

Each handler receives a ``params`` dict and returns a JSON-serialisable
result.  Errors are raised as plain exceptions and caught by the bridge
dispatcher which converts them into JSON-RPC error responses.

All 13 methods mirror the existing FastAPI routes but call ``src.*``
modules directly -- no HTTP involved.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from src.config_manager import (
    get_config,
    save_config,
    validate_concurrency,
    validate_writable_dir,
)
from src.diagnostics import (
    check_chrome_automation,
    check_internet,
    check_ip_address,
    check_proxies,
    check_site_reachability,
    check_tls_fingerprint,
)
from src.download_history import (
    get_completed_download,
    get_completed_md5s,
    get_download_history,
    get_download_stats,
)
from src.scraper import scrape_annas_archive

logger = logging.getLogger("bridge.handlers")

# ---------------------------------------------------------------------------
# Helpers shared across handlers
# ---------------------------------------------------------------------------

_MD5_RE = re.compile(r"^[a-fA-F0-9]{32}$")

# A full scraped page is 20 results; used to infer "there may be a next page".
SCRAPE_PAGE_SIZE = 20


def _validate_md5(md5: str) -> str:
    """Validate and return an MD5 hash string, or raise ValueError."""
    if not md5 or not _MD5_RE.match(md5):
        raise ValueError("Invalid md5 hash (must be 32 hex characters)")
    return md5


def _get_history_db() -> str | None:
    """Get the download history database path from config."""
    config = get_config()
    return config.get("history_db")


# ---------------------------------------------------------------------------
# Diagnostics helpers (strip Rich markup)
# ---------------------------------------------------------------------------


def _strip_rich_markup(text: str) -> str:
    return re.sub(r"\[/?[^\]]+\]", "", text)


def _status_from_bool(success: bool | None) -> str:
    if success is True:
        return "ok"
    if success is False:
        return "fail"
    return "warn"


def _redact_sensitive_message(name: str, success: bool | None, message: str) -> str:
    cleaned = _strip_rich_markup(message)
    if "ip" in name.lower():
        # Do NOT log the actual IP — privacy sensitive
        if success is True:
            return "ONLINE"
        if success is False:
            return "OFFLINE"
        return "check inconclusive"
    return cleaned


# ===================================================================
# HANDLERS — one function per JSON-RPC method
# ===================================================================


def handle_search(params: dict[str, Any]) -> dict[str, Any]:
    """search — live scrape from Anna's Archive."""
    query: str = params.get("query", "")
    if not query:
        raise ValueError("query parameter is required")

    ext = params.get("ext") or params.get("extension")
    lang = params.get("lang") or params.get("language")
    page: int = max(1, int(params.get("page", 1)))

    config = get_config()
    proxy_list: list[str] = config.get("proxies") or []

    results = scrape_annas_archive(query, ext=ext, lang=lang, page=page, proxies=proxy_list)

    # Flag results that already have a completed download so is_downloaded is
    # truthful (the scraper always returns False — it has no history).
    completed = get_completed_md5s(
        db_path=config.get("history_db"),
        md5s=[r.get("md5", "") for r in results],
    )
    for r in results:
        r["is_downloaded"] = r.get("md5", "") in completed

    # A live scrape has no grand total or page count, so report only what this
    # page returned. Pagination rides on has_next/has_prev — no fabricated
    # total_count-as-total or total_pages.
    return {
        "results": results,
        "total_count": len(results),
        "page": page,
        "has_next": len(results) >= SCRAPE_PAGE_SIZE,
        "has_prev": page > 1,
    }


def handle_start_download(params: dict[str, Any]) -> dict[str, Any]:
    """start_download — enqueue a download and return immediately."""
    md5 = _validate_md5(params.get("md5", ""))
    title: str = params.get("title", "")

    import download_manager

    return download_manager.enqueue(md5, title)


def handle_cancel_download(params: dict[str, Any]) -> dict[str, Any]:
    """cancel_download — cancel an active download."""
    md5 = _validate_md5(params.get("md5", ""))

    import download_manager

    return download_manager.cancel(md5)


def handle_get_downloads(params: dict[str, Any]) -> list[dict[str, Any]]:
    """get_downloads — return all active download statuses."""
    import download_manager

    return download_manager.get_all_statuses()


def handle_get_history(params: dict[str, Any]) -> list[dict[str, Any]]:
    """get_history — recent download history."""
    limit: int = min(params.get("limit", 50), 1000)  # clamp to sane max
    config = get_config()
    history_db = config.get("history_db")

    try:
        rows = get_download_history(db_path=history_db, limit=limit)
    except Exception as exc:
        logger.error("Failed to retrieve download history: %s", exc, exc_info=True)
        raise RuntimeError("Failed to retrieve download history.") from exc

    return [
        {
            "md5": row.get("md5", ""),
            "title": row.get("title"),
            "filename": row.get("filename"),
            "status": row.get("status"),
            "started_at": row.get("started_at"),
            "completed_at": row.get("completed_at"),
            "filesize_bytes": row.get("filesize_bytes"),
            "error": row.get("error"),
        }
        for row in rows
    ]


# Ingest handlers removed — app uses live scraping only, no local DB.


def handle_get_stats(params: dict[str, Any]) -> dict[str, Any]:
    """get_stats — download history statistics only (no archive DB)."""
    return get_download_stats(db_path=_get_history_db())


def handle_get_settings(params: dict[str, Any]) -> dict[str, Any]:
    """get_settings — return current config.

    Unlike the HTTP API, the Electron bridge does NOT redact proxy URLs.
    This is a local desktop app — the user's own credentials should be
    visible to them in the settings UI. Redacting would cause credential
    loss when the user saves any setting (the redacted URLs would overwrite
    the real ones in the config file).
    """
    config = get_config()
    out_dir = config.get("out_dir", "downloads")
    # Always return an absolute path so the frontend can display it.
    out_dir = os.path.abspath(out_dir)
    return {
        "out_dir": out_dir,
        "concurrency": config.get("concurrency", 2),
        "proxies": config.get("proxies", []),
    }


def handle_update_settings(params: dict[str, Any]) -> dict[str, Any]:
    """update_settings — update config, return the new state."""
    out_dir = params.get("out_dir")
    concurrency = params.get("concurrency")
    proxies = params.get("proxies")

    # Treat empty strings as None (no change)
    if out_dir is not None and not out_dir.strip():
        out_dir = None

    # Validate concurrency (strict — reject out-of-bounds rather than clamp)
    if concurrency is not None:
        concurrency = validate_concurrency(int(concurrency))

    # Validate out_dir is a user-writable directory (no project-root restriction)
    if out_dir is not None:
        out_dir = validate_writable_dir(out_dir)

    updated = save_config(
        out_dir=out_dir,
        concurrency=concurrency,
        proxies=proxies,
    )
    # Return RAW proxies (not redacted), matching handle_get_settings. The UI
    # writes this response back into its form state, so redacting here would
    # overwrite the real credentials in the config on the next save. This is a
    # local desktop app — the user's own credentials are theirs to see.
    return {
        "out_dir": updated.get("out_dir", "downloads"),
        "concurrency": updated.get("concurrency", 2),
        "proxies": updated.get("proxies", []),
    }


def handle_reload_config(params: dict[str, Any]) -> dict[str, Any]:
    """reload_config — apply config changes without restarting.

    Resets the concurrency semaphore so the next enqueued download picks up
    the updated limit. Returns the current settings so the caller can confirm
    the new values are live.
    """
    import download_manager

    download_manager.reset_concurrency_semaphore()
    return handle_get_settings({})


def handle_run_diagnostics(params: dict[str, Any]) -> list[dict[str, Any]]:
    """run_diagnostics — execute all health checks."""
    config = get_config()

    proxies: list[str] = config.get("proxies") or []
    checks = [
        ("Internet Connection", check_internet()),
        ("Public IP Address", check_ip_address()),
        ("Anna's Archive Reachability", check_site_reachability("https://annas-archive.gl")),
        ("Browser Automation", check_chrome_automation()),
        ("TLS Fingerprint", check_tls_fingerprint()),
        ("Proxy Health", check_proxies(proxies)),
    ]

    results: list[dict[str, Any]] = []
    for name, (success, message) in checks:
        results.append(
            {
                "name": name,
                "status": _status_from_bool(success),
                "message": _redact_sensitive_message(name, success, message),
            }
        )

    return results


def handle_resolve_download_path(params: dict[str, Any]) -> str | None:
    """resolve_download_path — return a realpath-contained absolute file path
    for a completed download by md5, or None.

    Used by the main process to back ``showItemInFolder``. The resolved path
    MUST live inside the configured (validated) downloads directory — any
    path that escapes it is rejected to prevent revealing arbitrary files.
    """
    md5 = _validate_md5(params.get("md5", ""))

    record = get_completed_download(db_path=_get_history_db(), md5=md5)
    if not record or not record.get("filename"):
        return None

    out_dir_abs = os.path.realpath(validate_writable_dir(get_config().get("out_dir", "downloads")))
    file_path = os.path.realpath(os.path.join(out_dir_abs, record["filename"]))

    # Reject path escapes (e.g. a stored filename containing ../).
    if not file_path.startswith(out_dir_abs + os.sep):
        return None
    if not os.path.exists(file_path):
        return None
    return file_path


# ===================================================================
# Registration — called by bridge.main()
# ===================================================================


def register_handlers() -> None:
    """Bind all method names to their handler functions."""
    from bridge import register_method

    register_method("search", handle_search)
    register_method("start_download", handle_start_download)
    register_method("cancel_download", handle_cancel_download)
    register_method("get_downloads", handle_get_downloads)
    register_method("get_history", handle_get_history)
    register_method("get_stats", handle_get_stats)
    register_method("get_settings", handle_get_settings)
    register_method("update_settings", handle_update_settings)
    register_method("reload_config", handle_reload_config)
    register_method("run_diagnostics", handle_run_diagnostics)
    register_method("resolve_download_path", handle_resolve_download_path)
