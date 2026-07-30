"""DB-driven Library query module (ADR-0006).

Owns SQLite joins, Books/Audiobooks classification, filters, sorting, and facet
derivation. This is the **sole** Library collection path: bridge
``list_library`` → :func:`query_library` → renderer. There is no parallel
``download_history.list_library`` API.

The renderer only holds transient view state (tab, grid/list) and presentation;
it must not re-infer classification or reconstruct facets. Audiobook detail and
player commands remain separate from this collection query.

Classification uses authoritative ``downloads.media_type`` (set by the backend
after artifact inspection). Completed rows with NULL media_type are treated as
books (same policy as :func:`download_history.backfill_media_type`).
"""

from __future__ import annotations

from itertools import groupby
from typing import Any

from .download_history import _connect

# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

MEDIA_KIND_ALL = "all"
MEDIA_KIND_BOOKS = "books"
MEDIA_KIND_AUDIOBOOKS = "audiobooks"
_VALID_MEDIA_KINDS = frozenset({MEDIA_KIND_ALL, MEDIA_KIND_BOOKS, MEDIA_KIND_AUDIOBOOKS})

SORT_AUTHOR = "author"
SORT_YEAR = "year"
SORT_TITLE = "title"
SORT_RECENT = "recent"
_VALID_SORTS = frozenset({SORT_AUTHOR, SORT_YEAR, SORT_TITLE, SORT_RECENT})

VARIANT_BOOK = "book"
VARIANT_AUDIOBOOK = "audiobook"


def _normalize_media_kind(media_kind: str | None) -> str:
    kind = (media_kind or MEDIA_KIND_ALL).strip().lower()
    if kind not in _VALID_MEDIA_KINDS:
        raise ValueError(
            f"Invalid media_kind {media_kind!r}; expected one of "
            f"{sorted(_VALID_MEDIA_KINDS)}"
        )
    return kind


def _normalize_sort(sort: str | None) -> str:
    key = (sort or SORT_RECENT).strip().lower()
    if key not in _VALID_SORTS:
        raise ValueError(
            f"Invalid sort {sort!r}; expected one of {sorted(_VALID_SORTS)}"
        )
    return key


def _normalized_media_type(raw: str | None) -> str:
    """Map stored media_type to a Library variant; NULL → book (backfill policy)."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return VARIANT_BOOK
    value = raw.strip().lower()
    if value == VARIANT_AUDIOBOOK:
        return VARIANT_AUDIOBOOK
    return VARIANT_BOOK


def _blank_to_none(value: Any) -> Any:
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _row_to_item(row: dict[str, Any]) -> dict[str, Any]:
    """Build a variant-tagged Library item from a joined downloads/audiobooks row."""
    variant = _normalized_media_type(row.get("media_type"))

    core: dict[str, Any] = {
        "md5": row["md5"],
        "title": row.get("title"),
        "author": row.get("author"),
        "year": row.get("year"),
        "cover_url": row.get("cover_url"),
        "filename": row.get("filename"),
        "filesize_bytes": row.get("filesize_bytes"),
        "completed_at": row.get("completed_at"),
        "media_type": variant,
        "variant": variant,
    }

    # Book-oriented fields remain on every item (null for pure audiobooks) so
    # the detail sheet and facets stay simple.
    core["extension"] = row.get("extension")
    core["content_type"] = row.get("content_type")
    core["language"] = row.get("language")
    core["publisher"] = row.get("publisher")

    if variant == VARIANT_AUDIOBOOK:
        core["status"] = row.get("ab_status")
        core["container_type"] = row.get("container_type")
        core["folder_path"] = row.get("folder_path")
        core["total_duration_seconds"] = row.get("total_duration_seconds")
        core["track_count"] = row.get("track_count")
        core["error_message"] = row.get("error_message")
    else:
        core["status"] = None
        core["container_type"] = None
        core["folder_path"] = None
        core["total_duration_seconds"] = None
        core["track_count"] = None
        core["error_message"] = None

    return core


def _sort_items(items: list[dict[str, Any]], sort: str) -> list[dict[str, Any]]:
    """Sort items with stable md5 ASC tie-breaker and deterministic nulls.

    Null / empty handling matches the prior client-side Library page:
    - author/title: case-insensitive ascending; empty strings sort first
    - year: newest first; missing years sink to the bottom
    - recent: completed_at DESC; missing completed_at last
    """
    if sort == SORT_AUTHOR:
        return sorted(
            items,
            key=lambda it: ((it.get("author") or "").lower(), it.get("md5") or ""),
        )
    if sort == SORT_TITLE:
        return sorted(
            items,
            key=lambda it: ((it.get("title") or "").lower(), it.get("md5") or ""),
        )
    if sort == SORT_YEAR:
        # has_year first (0), then year DESC via negation, then md5 ASC.
        return sorted(
            items,
            key=lambda it: (
                0 if it.get("year") is not None else 1,
                -(it["year"] if it.get("year") is not None else 0),
                it.get("md5") or "",
            ),
        )
    # recent: completed_at DESC, nulls last, md5 ASC for ties
    return _sort_recent(items)


def _sort_recent(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """completed_at DESC, nulls last, md5 ASC for ties."""
    present = [it for it in items if it.get("completed_at")]
    missing = [it for it in items if not it.get("completed_at")]
    present_sorted = sorted(
        present,
        key=lambda it: it.get("completed_at") or "",
        reverse=True,
    )
    groups: list[dict[str, Any]] = []
    for _, group in groupby(present_sorted, key=lambda it: it.get("completed_at") or ""):
        groups.extend(sorted(group, key=lambda it: it.get("md5") or ""))
    missing_sorted = sorted(missing, key=lambda it: it.get("md5") or "")
    return groups + missing_sorted


def _distinct_facet(items: list[dict[str, Any]], key: str) -> list[str]:
    values: set[str] = set()
    for item in items:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            values.add(value.strip())
    return sorted(values, key=lambda s: s.lower())


def _matches_filters(
    item: dict[str, Any],
    *,
    content_type: str | None,
    extension: str | None,
    language: str | None,
) -> bool:
    if content_type is not None:
        if (item.get("content_type") or "") != content_type:
            return False
    if extension is not None:
        if (item.get("extension") or "") != extension:
            return False
    if language is not None:
        if (item.get("language") or "") != language:
            return False
    return True


def query_library(
    db_path: str | None = None,
    *,
    media_kind: str = MEDIA_KIND_ALL,
    content_type: str | None = None,
    extension: str | None = None,
    language: str | None = None,
    sort: str = SORT_RECENT,
) -> dict[str, Any]:
    """Query the Library: completed downloads as Book/Audiobook variants.

    Parameters
    ----------
    media_kind:
        ``"books"``, ``"audiobooks"``, or ``"all"`` (default).
    content_type, extension, language:
        Exact-match filters; ``None`` means no filter on that facet.
        Empty strings are treated as no filter.
    sort:
        ``"author"`` | ``"year"`` | ``"title"`` | ``"recent"`` (default).

    Returns
    -------
    dict with:
      - ``items``: filtered + sorted variant-tagged rows (no pagination).
      - ``facets``: distinct content_types / extensions / languages from the
        **eligible** set (media_kind applied; filters NOT applied) so the UI
        can offer stable options.
      - ``total_eligible``: count after media_kind, before facet filters.
      - ``filtered_count``: ``len(items)`` after facet filters.
    """
    kind = _normalize_media_kind(media_kind)
    sort_key = _normalize_sort(sort)

    # Normalize blank filter strings to None (no filter).
    content_type = _blank_to_none(content_type)
    extension = _blank_to_none(extension)
    language = _blank_to_none(language)

    with _connect(db_path) as conn:
        cursor = conn.execute(
            """
            SELECT
                d.md5,
                d.title,
                d.filename,
                d.author,
                d.year,
                d.extension,
                d.content_type,
                d.language,
                d.publisher,
                d.cover_url,
                d.filesize_bytes,
                d.completed_at,
                d.media_type,
                a.container_type,
                a.folder_path,
                a.total_duration_seconds,
                a.track_count,
                a.status AS ab_status,
                a.error_message
            FROM downloads d
            LEFT JOIN audiobooks a ON a.md5 = d.md5
            WHERE d.status = 'completed'
            """
        )
        rows = [dict(row) for row in cursor.fetchall()]

    # Classify + apply media_kind eligibility.
    eligible: list[dict[str, Any]] = []
    for row in rows:
        item = _row_to_item(row)
        variant = item["variant"]
        if kind == MEDIA_KIND_BOOKS and variant != VARIANT_BOOK:
            continue
        if kind == MEDIA_KIND_AUDIOBOOKS and variant != VARIANT_AUDIOBOOK:
            continue
        eligible.append(item)

    facets = {
        "content_types": _distinct_facet(eligible, "content_type"),
        "extensions": _distinct_facet(eligible, "extension"),
        "languages": _distinct_facet(eligible, "language"),
    }
    total_eligible = len(eligible)

    filtered = [
        item
        for item in eligible
        if _matches_filters(
            item,
            content_type=content_type if isinstance(content_type, str) else None,
            extension=extension if isinstance(extension, str) else None,
            language=language if isinstance(language, str) else None,
        )
    ]
    sorted_items = _sort_items(filtered, sort_key)

    return {
        "items": sorted_items,
        "facets": facets,
        "total_eligible": total_eligible,
        "filtered_count": len(sorted_items),
    }
