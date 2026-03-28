"""Search endpoint — live Anna's Archive scraping."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Query, HTTPException

from ..models import BookRecord, SearchResponse

from src.scraper import scrape_annas_archive

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=SearchResponse)
def search_books(
    query: str = Query(..., min_length=1, description="Search query"),
    ext: Optional[str] = Query(None, description="Filter by file extension"),
    lang: Optional[str] = Query(None, description="Filter by language code"),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(10, ge=1, le=100, description="Results per page"),
) -> SearchResponse:
    """Search books via live scraping of Anna's Archive."""

    try:
        all_results = scrape_annas_archive(query, ext=ext, lang=lang, page=page)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Slice to respect per_page (scraper returns up to ~50 results)
    offset = (page - 1) * per_page
    page_dicts = all_results[offset:offset + per_page]

    # Convert plain dicts from the shared scraper into Pydantic models
    results = [BookRecord(**d) for d in page_dicts]

    # Anna's Archive returns ~20 results per page. If we got fewer results
    # than that threshold, we're on the last page.
    SCRAPE_PAGE_SIZE = 20
    return SearchResponse(
        results=results,
        total_count=len(all_results),
        page=page,
        per_page=per_page,
        total_pages=max(1, (len(all_results) + per_page - 1) // per_page),
        has_next=len(all_results) >= SCRAPE_PAGE_SIZE,
        has_prev=page > 1,
    )
