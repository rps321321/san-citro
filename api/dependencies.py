"""Shared FastAPI dependencies for the Anna's Archive API."""

from __future__ import annotations

import hmac
import logging
import os
from typing import Any, Dict, Optional

from fastapi import HTTPException, Header, Query, status

from src.config_manager import get_config

logger = logging.getLogger(__name__)


def get_current_config() -> Dict[str, Any]:
    """Return the current application configuration dictionary."""
    return get_config()


def get_db_path() -> str | None:
    """Extract db_path from config. Returns None if not configured."""
    config = get_config()
    return config.get("db_path") or None


def _get_configured_api_key() -> str | None:
    """Return the configured API key from env var or config file.

    Checks API_KEY environment variable first, then falls back to the
    ``api_key`` field in the application config. Returns None when no
    key is configured (local-dev / open mode).
    """
    env_key = os.environ.get("API_KEY", "").strip()
    if env_key:
        return env_key
    config_key = get_config().get("api_key", "")
    if isinstance(config_key, str) and config_key.strip():
        return config_key.strip()
    return None


def require_api_key(
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    # NOTE: The query parameter is retained solely for browser EventSource
    # (SSE) clients that cannot set custom headers. Prefer the X-API-Key
    # header in all other cases — query params leak into server logs, browser
    # history, and referrer headers.
    api_key: Optional[str] = Query(None, alias="api_key"),
) -> None:
    """FastAPI dependency that enforces API-key authentication.

    Accepts the key via the ``X-API-Key`` header (preferred) or the
    ``api_key`` query parameter (deprecated — kept only for SSE/EventSource
    clients that cannot set headers).

    When no API key is configured on the server side (env var empty /
    missing **and** config field absent), authentication is skipped
    entirely so local development works without friction.
    """
    configured_key = _get_configured_api_key()
    if configured_key is None:
        # No key configured -- local dev mode, allow all requests.
        return

    provided_key: str | None = None
    if x_api_key:
        provided_key = x_api_key
    elif api_key:
        provided_key = api_key
        logger.warning(
            "API key provided via query parameter (deprecated). "
            "Use the X-API-Key header instead. Query params leak into "
            "server logs and browser history."
        )

    if not provided_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "missing_api_key", "message": "API key required. Provide via X-API-Key header."}},
        )
    # Use constant-time comparison to prevent timing attacks that could
    # leak key bytes through response-time differences.
    if not hmac.compare_digest(provided_key, configured_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "invalid_api_key", "message": "Invalid API key."}},
        )
