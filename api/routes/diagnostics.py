"""Diagnostics endpoint: run all health checks and return structured results."""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter

from ..models import DiagnosticResult

from src.config_manager import get_config
from src.diagnostics import (
    check_chrome_automation,
    check_internet,
    check_ip_address,
    check_site_reachability,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


def _strip_rich_markup(text: str) -> str:
    """Remove Rich markup tags like [bold green]...[/bold green] from a string."""
    return re.sub(r"\[/?[^\]]+\]", "", text)


def _status_from_bool(success: bool | None) -> str:
    """Convert a boolean diagnostic result to a status string."""
    if success is True:
        return "ok"
    if success is False:
        return "fail"
    return "warn"


def _redact_sensitive_message(name: str, success: bool | None, message: str) -> str:
    """Redact sensitive information from diagnostic messages.

    For IP-related checks, replace the actual IP/message with a safe status.
    """
    cleaned = _strip_rich_markup(message)
    if "ip" in name.lower():
        # Never expose the server's public IP address to the client
        logger.info("IP check result: %s", cleaned)
        if success is True:
            return "ONLINE"
        if success is False:
            return "OFFLINE"
        return "check inconclusive"
    return cleaned


@router.get("", response_model=list[DiagnosticResult])
def run_all_diagnostics() -> list[DiagnosticResult]:
    """Run all system health checks and return structured results.

    Checks include: internet connectivity, IP reachability, site reachability,
    database health, and browser automation availability.
    """
    config = get_config()

    checks = [
        ("Internet Connection", check_internet()),
        ("Public IP Address", check_ip_address()),
        ("Anna's Archive Reachability", check_site_reachability("https://annas-archive.gl")),
        ("Browser Automation", check_chrome_automation()),
    ]

    results: list[DiagnosticResult] = []
    for name, (success, message) in checks:
        results.append(
            DiagnosticResult(
                name=name,
                status=_status_from_bool(success),
                message=_redact_sensitive_message(name, success, message),
            )
        )

    return results
