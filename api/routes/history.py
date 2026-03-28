"""Download history endpoint."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from ..models import HistoryEntry

from src.download_history import get_download_history
from src.config_manager import get_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/history", tags=["history"])


@router.get("", response_model=list[HistoryEntry])
def list_history(
    limit: int = Query(50, ge=1, le=500, description="Maximum entries to return"),
) -> list[HistoryEntry]:
    """Return recent download history, newest first."""
    config = get_config()
    history_db = config.get("history_db")

    try:
        rows = get_download_history(db_path=history_db, limit=limit)
    except Exception as exc:
        logger.error("Failed to retrieve download history: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve download history.",
        )

    return [
        HistoryEntry(
            md5=row.get("md5", ""),
            title=row.get("title"),
            filename=row.get("filename"),
            status=row.get("status"),
            started_at=row.get("started_at"),
            completed_at=row.get("completed_at"),
            filesize_bytes=row.get("filesize_bytes"),
            error=row.get("error"),
        )
        for row in rows
    ]
