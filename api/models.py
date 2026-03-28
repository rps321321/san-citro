"""Pydantic models for the Anna's Archive API."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Book / Search
# ---------------------------------------------------------------------------

class BookRecord(BaseModel):
    """A single book record from the local database."""

    title: Optional[str] = None
    author: Optional[str] = None
    year: Optional[str] = None
    extension: Optional[str] = None
    md5: str
    language: Optional[str] = None
    filesize_bytes: Optional[int] = None
    publisher: Optional[str] = None
    isbn13: Optional[str] = None
    is_downloaded: bool = False


class SearchResponse(BaseModel):
    """Paginated search results."""

    results: list[BookRecord]
    total_count: int
    page: int
    per_page: int
    total_pages: int
    has_next: bool
    has_prev: bool


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------

class DownloadStatusEnum(str, Enum):
    queued = "queued"
    started = "started"
    downloading = "downloading"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class DownloadRequest(BaseModel):
    """Request body to enqueue a new download."""

    md5: str = Field(..., pattern=r"^[a-fA-F0-9]{32}$")
    title: str = ""


class DownloadStatus(BaseModel):
    """Current status of a single download job."""

    md5: str
    title: str = ""
    status: DownloadStatusEnum = DownloadStatusEnum.queued
    progress_percent: float = 0.0
    error: Optional[str] = None
    filename: Optional[str] = None
    started_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

class HistoryEntry(BaseModel):
    """A single download history record."""

    md5: str
    title: Optional[str] = None
    filename: Optional[str] = None
    status: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    filesize_bytes: Optional[int] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Settings / Config
# ---------------------------------------------------------------------------

class ConfigModel(BaseModel):
    """Application configuration."""

    db_path: Optional[str] = None
    out_dir: str = "downloads"
    concurrency: int = 2
    proxies: list[str] = Field(default_factory=list)


class ConfigUpdateRequest(BaseModel):
    """Partial config update -- all fields optional."""

    db_path: Optional[str] = None
    out_dir: Optional[str] = None
    concurrency: Optional[int] = None
    proxies: Optional[list[str]] = None


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

class DiagnosticResult(BaseModel):
    """Result of a single health check."""

    name: str
    status: str  # "ok", "fail", "warn"
    message: str
