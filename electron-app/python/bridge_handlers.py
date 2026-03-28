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
import sqlite3
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

from src.config_manager import get_config, save_config
from src.scraper import scrape_annas_archive
from src.diagnostics import (
    check_chrome_automation,
    check_internet,
    check_ip_address,
    check_proxies,
    check_site_reachability,
    check_tls_fingerprint,
)
from src.download_history import get_download_history

logger = logging.getLogger("bridge.handlers")

# ---------------------------------------------------------------------------
# Helpers shared across handlers
# ---------------------------------------------------------------------------

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


_MD5_RE = re.compile(r"^[a-fA-F0-9]{32}$")


def _validate_md5(md5: str) -> str:
    """Validate and return an MD5 hash string, or raise ValueError."""
    if not md5 or not _MD5_RE.match(md5):
        raise ValueError("Invalid md5 hash (must be 32 hex characters)")
    return md5


def _connect_db(db_path: str) -> sqlite3.Connection:
    """Open a SQLite connection with WAL mode and busy timeout.

    All bridge handler DB access should go through this helper to ensure
    consistent settings and avoid 'database is locked' errors during
    concurrent ingest.
    """
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _get_history_db() -> Optional[str]:
    """Get the download history database path from config."""
    config = get_config()
    return config.get("history_db")


# ---------------------------------------------------------------------------
# Diagnostics helpers (strip Rich markup)
# ---------------------------------------------------------------------------

def _strip_rich_markup(text: str) -> str:
    return re.sub(r"\[/?[^\]]+\]", "", text)


def _status_from_bool(success: Optional[bool]) -> str:
    if success is True:
        return "ok"
    if success is False:
        return "fail"
    return "warn"


def _redact_sensitive_message(name: str, success: Optional[bool], message: str) -> str:
    cleaned = _strip_rich_markup(message)
    if "ip" in name.lower():
        # Do NOT log the actual IP — privacy sensitive
        if success is True:
            return "ONLINE"
        if success is False:
            return "OFFLINE"
        return "check inconclusive"
    return cleaned


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------

def _redact_proxy_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.username or parsed.password:
        netloc = f"{parsed.hostname}:{parsed.port}" if parsed.port else parsed.hostname
        clean = parsed._replace(netloc=netloc)
        return urlunparse(clean)
    return url


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

    # The scraper already returns one page of results (typically 20).
    # Pass them through directly — no second layer of pagination.
    SCRAPE_PAGE_SIZE = 20

    return {
        "results": results,
        "total_count": len(results),
        "page": page,
        "per_page": SCRAPE_PAGE_SIZE,
        "total_pages": page + (1 if len(results) >= SCRAPE_PAGE_SIZE else 0),
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
    config = get_config()
    history_db = config.get("history_db")

    downloads_by_status: dict[str, int] = {}
    total_downloads = 0
    total_size = 0

    if history_db and os.path.exists(history_db):
        try:
            with _connect_db(history_db) as conn:
                cursor = conn.cursor()
                rows = cursor.execute(
                    "SELECT status, COUNT(*) as cnt FROM downloads GROUP BY status"
                ).fetchall()
                for status_name, count in rows:
                    downloads_by_status[status_name or "unknown"] = count
                    total_downloads += count

                size_row = cursor.execute(
                    "SELECT COALESCE(SUM(filesize_bytes), 0) FROM downloads "
                    "WHERE status = 'completed'"
                ).fetchone()
                total_size = size_row[0] if size_row else 0
        except sqlite3.OperationalError:
            pass

    return {
        "total_downloads": total_downloads,
        "total_size_bytes": total_size,
        "downloads_by_status": downloads_by_status,
    }


def handle_get_settings(params: dict[str, Any]) -> dict[str, Any]:
    """get_settings — return current config.

    Unlike the HTTP API, the Electron bridge does NOT redact proxy URLs.
    This is a local desktop app — the user's own credentials should be
    visible to them in the settings UI. Redacting would cause credential
    loss when the user saves any setting (the redacted URLs would overwrite
    the real ones in the config file).
    """
    config = get_config()
    return {
        "out_dir": config.get("out_dir", "downloads"),
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

    # Validate concurrency
    if concurrency is not None:
        concurrency = int(concurrency)
        if not (1 <= concurrency <= 32):
            raise ValueError("concurrency must be between 1 and 32.")

    # Validate out_dir is within project root
    if out_dir is not None:
        resolved = Path(out_dir).resolve()
        if not resolved.is_relative_to(_PROJECT_ROOT):
            raise PermissionError("out_dir must be within the project directory.")
        out_dir = str(resolved)

    updated = save_config(
        out_dir=out_dir,
        concurrency=concurrency,
        proxies=proxies,
    )
    raw_proxies: list[str] = updated.get("proxies", [])
    return {
        "db_path": updated.get("db_path"),
        "out_dir": updated.get("out_dir", "downloads"),
        "concurrency": updated.get("concurrency", 2),
        "proxies": [_redact_proxy_url(p) for p in raw_proxies],
    }


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
        results.append({
            "name": name,
            "status": _status_from_bool(success),
            "message": _redact_sensitive_message(name, success, message),
        })

    return results


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
    register_method("run_diagnostics", handle_run_diagnostics)
