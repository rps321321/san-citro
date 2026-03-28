"""Download management endpoints: enqueue, list, cancel, and SSE stream."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Path, Request
from sse_starlette.sse import EventSourceResponse

from ..models import DownloadRequest, DownloadStatus

router = APIRouter(prefix="/downloads", tags=["downloads"])


def _get_manager(request: Request):
    """Extract the DownloadManager from app state."""
    manager = getattr(request.app.state, "download_manager", None)
    if manager is None:
        raise HTTPException(
            status_code=503,
            detail="Download manager is not available.",
        )
    return manager


@router.post("", response_model=DownloadStatus)
def enqueue_download(
    body: DownloadRequest,
    request: Request,
) -> DownloadStatus:
    """Enqueue a new download job.

    If a download for the same MD5 is already active, returns
    the existing status without creating a duplicate.
    """
    manager = _get_manager(request)
    status = manager.enqueue(md5=body.md5, title=body.title)
    return status


@router.get("", response_model=list[DownloadStatus])
def list_downloads(request: Request) -> list[DownloadStatus]:
    """List all active and recent download jobs."""
    manager = _get_manager(request)
    return manager.get_all_statuses()


@router.delete("/{md5}")
def cancel_download(
    md5: str = Path(..., pattern=r"^[a-fA-F0-9]{32}$"),
    request: Request = ...,
) -> dict:
    """Cancel a queued or running download by MD5 hash."""
    manager = _get_manager(request)
    cancelled = manager.cancel(md5)
    if not cancelled:
        raise HTTPException(
            status_code=404,
            detail="No active download found for the given MD5.",
        )
    return {"detail": "Download cancelled."}


@router.get("/stream")
async def download_stream(request: Request) -> EventSourceResponse:
    """Server-Sent Events stream of download status updates.

    Clients connect to this endpoint to receive real-time progress
    updates for all active downloads. Each event is a JSON-serialized
    DownloadStatus object.
    """
    manager = _get_manager(request)

    async def event_generator():
        # Replay current state so the client doesn't miss in-progress downloads
        for status in manager.get_all_statuses():
            if await request.is_disconnected():
                return
            yield {
                "event": "download_status",
                "data": status.model_dump_json(),
            }

        async for status in manager.subscribe():
            # Check if client disconnected
            if await request.is_disconnected():
                break
            yield {
                "event": "download_status",
                "data": status.model_dump_json(),
            }

    return EventSourceResponse(event_generator())
