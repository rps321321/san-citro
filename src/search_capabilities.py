"""Authoritative Search sort and facet capabilities for Anna's Archive.

Single source of truth for values the product may send as ``sort``, ``ext``,
and ``lang`` query params. The bridge returns this metadata on every search
response so the renderer can render options without hard-coding AA vocabulary.

Upstream reference (SearXNG / AA search form):
- ``sort``: empty = most relevant; newest, oldest, largest, smallest,
  newest_added, oldest_added (``random`` omitted — unstable across pages).
- ``ext`` / ``lang``: filter params already accepted by AA ``/search``.
"""

from __future__ import annotations

from typing import Any

# Default = most relevant. Empty string is the AA/SearXNG convention.
SORT_RELEVANCE = ""

# Stable global sorts only — do not include ``random`` (reorders per request).
SEARCH_SORTS: tuple[dict[str, str], ...] = (
    {"value": SORT_RELEVANCE, "label": "Relevance"},
    {"value": "newest", "label": "Newest"},
    {"value": "oldest", "label": "Oldest"},
    {"value": "largest", "label": "Largest"},
    {"value": "smallest", "label": "Smallest"},
    {"value": "newest_added", "label": "Recently added"},
    {"value": "oldest_added", "label": "Oldest added"},
)

SEARCH_EXTENSIONS: tuple[dict[str, str], ...] = (
    {"value": "pdf", "label": "PDF"},
    {"value": "epub", "label": "EPUB"},
    {"value": "djvu", "label": "DJVU"},
    {"value": "mobi", "label": "MOBI"},
    {"value": "azw3", "label": "AZW3"},
    {"value": "fb2", "label": "FB2"},
    {"value": "txt", "label": "TXT"},
    {"value": "cbr", "label": "CBR"},
    {"value": "cbz", "label": "CBZ"},
)

# Display names match AA card language tokens and the historic product filter.
# AA's form also accepts codes; names remain the product contract for now.
SEARCH_LANGUAGES: tuple[dict[str, str], ...] = (
    {"value": "English", "label": "English"},
    {"value": "Russian", "label": "Russian"},
    {"value": "German", "label": "German"},
    {"value": "French", "label": "French"},
    {"value": "Spanish", "label": "Spanish"},
    {"value": "Italian", "label": "Italian"},
    {"value": "Chinese", "label": "Chinese"},
    {"value": "Japanese", "label": "Japanese"},
    {"value": "Portuguese", "label": "Portuguese"},
)

_VALID_SORTS: frozenset[str] = frozenset(s["value"] for s in SEARCH_SORTS)


def normalize_sort(sort: str | None) -> str:
    """Return a validated sort value; unknown → relevance (empty string)."""
    if sort is None:
        return SORT_RELEVANCE
    value = str(sort).strip()
    if value not in _VALID_SORTS:
        return SORT_RELEVANCE
    return value


def search_capabilities() -> dict[str, Any]:
    """Payload fragment attached to every search response."""
    return {
        "sorts": [dict(s) for s in SEARCH_SORTS],
        "extensions": [dict(e) for e in SEARCH_EXTENSIONS],
        "languages": [dict(lang) for lang in SEARCH_LANGUAGES],
    }
