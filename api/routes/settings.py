"""Settings endpoints: read and update application configuration."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, HTTPException

from ..models import ConfigModel, ConfigUpdateRequest

from src.config_manager import get_config, save_config

router = APIRouter(prefix="/settings", tags=["settings"])

# Allowed base directories for path settings.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

_CONCURRENCY_MIN = 1
_CONCURRENCY_MAX = 32


def _redact_proxy_url(url: str) -> str:
    """Redact credentials from proxy URLs, returning only scheme://host:port.

    Uses urllib.parse to correctly handle percent-encoded characters
    (e.g. ``%40`` for ``@``) in userinfo fields.
    """
    parsed = urlparse(url)
    if parsed.username or parsed.password:
        netloc = f"{parsed.hostname}:{parsed.port}" if parsed.port else parsed.hostname
        clean = parsed._replace(netloc=netloc)
        return urlunparse(clean)
    return url


def _validate_path_within_project(value: str, field_name: str) -> str:
    """Ensure a path resolves to within the project root directory."""
    try:
        resolved = Path(value).resolve()
    except (OSError, ValueError):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid path for {field_name}.",
        )

    if not resolved.is_relative_to(_PROJECT_ROOT):
        raise HTTPException(
            status_code=403,
            detail=f"{field_name} must be within the project directory.",
        )
    return str(resolved)


@router.get("", response_model=ConfigModel)
def get_settings() -> ConfigModel:
    """Return the current application configuration.

    Proxy URLs are redacted to avoid leaking credentials.
    """
    config = get_config()
    raw_proxies: list[str] = config.get("proxies", [])
    return ConfigModel(
        db_path=config.get("db_path"),
        out_dir=config.get("out_dir", "downloads"),
        concurrency=config.get("concurrency", 2),
        proxies=[_redact_proxy_url(p) for p in raw_proxies],
    )


@router.put("", response_model=ConfigModel)
def update_settings(body: ConfigUpdateRequest) -> ConfigModel:
    """Update application configuration.

    Only provided (non-None) fields are updated. Omitted fields
    retain their current values.

    Validates:
    - db_path and out_dir must resolve within the project directory.
    - concurrency must be between 1 and 32.
    """
    # Validate paths if provided
    if body.db_path is not None:
        body.db_path = _validate_path_within_project(body.db_path, "db_path")

    if body.out_dir is not None:
        body.out_dir = _validate_path_within_project(body.out_dir, "out_dir")

    # Validate concurrency range
    if body.concurrency is not None:
        if not (_CONCURRENCY_MIN <= body.concurrency <= _CONCURRENCY_MAX):
            raise HTTPException(
                status_code=400,
                detail=f"concurrency must be between {_CONCURRENCY_MIN} and {_CONCURRENCY_MAX}.",
            )

    updated = save_config(
        db_path=body.db_path,
        out_dir=body.out_dir,
        concurrency=body.concurrency,
        proxies=body.proxies,
    )
    raw_proxies: list[str] = updated.get("proxies", [])
    return ConfigModel(
        db_path=updated.get("db_path"),
        out_dir=updated.get("out_dir", "downloads"),
        concurrency=updated.get("concurrency", 2),
        proxies=[_redact_proxy_url(p) for p in raw_proxies],
    )
