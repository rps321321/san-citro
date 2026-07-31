"""Tests for the DB-driven Library query module (ADR-0006 / Phase 2)."""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING
from unittest.mock import patch

import pytest

if TYPE_CHECKING:
    from pathlib import Path

from src.audiobook_db import record_audiobook
from src.download_history import (
    record_download_complete,
    record_download_failed,
    record_download_start,
    set_media_type,
)
from src.library import (
    MEDIA_KIND_ALL,
    MEDIA_KIND_AUDIOBOOKS,
    MEDIA_KIND_BOOKS,
    SORT_AUTHOR,
    SORT_RECENT,
    SORT_TITLE,
    SORT_YEAR,
    VARIANT_AUDIOBOOK,
    VARIANT_BOOK,
    query_library,
)
from src.migrations import run_migrations

_BOOK_A = "a" * 32
_BOOK_B = "b" * 32
_BOOK_C = "c" * 32
_AUDIO_READY = "d" * 32
_AUDIO_PROC = "e" * 32
_INCOMPLETE = "f" * 32


@pytest.fixture()
def lib_db(tmp_path: Path) -> str:
    """Temp SQLite path migrated via the production path."""
    db_path = str(tmp_path / "library.db")
    run_migrations(db_path)
    return db_path


def _complete_book(
    db: str,
    md5: str,
    title: str,
    *,
    author: str | None = None,
    year: int | None = None,
    extension: str | None = None,
    content_type: str | None = None,
    language: str | None = None,
    publisher: str | None = None,
    cover_url: str | None = None,
    media_type: str | None = "book",
    filename: str | None = None,
    filesize: int = 1000,
) -> None:
    meta: dict = {}
    if author is not None:
        meta["author"] = author
    if year is not None:
        meta["year"] = year
    if extension is not None:
        meta["extension"] = extension
    if content_type is not None:
        meta["content_type"] = content_type
    if language is not None:
        meta["language"] = language
    if publisher is not None:
        meta["publisher"] = publisher
    if cover_url is not None:
        meta["cover_url"] = cover_url
    if media_type is not None:
        meta["media_type"] = media_type
    record_download_start(db, md5=md5, title=title, meta=meta or None)
    record_download_complete(
        db,
        md5=md5,
        filename=filename or f"{title}.epub",
        filesize_bytes=filesize,
    )


def _complete_audiobook(
    db: str,
    md5: str,
    title: str,
    *,
    status: str = "ready",
    author: str | None = None,
    extension: str | None = "zip",
    content_type: str | None = None,
    language: str | None = None,
    track_count: int | None = 3,
    total_duration_seconds: float | None = 3600.0,
    container_type: str | None = "zip",
    folder_path: str | None = None,
    cover_url: str | None = None,
) -> None:
    _complete_book(
        db,
        md5,
        title,
        author=author,
        extension=extension,
        content_type=content_type,
        language=language,
        cover_url=cover_url,
        media_type="audiobook",
        filename=f"{title}.zip",
    )
    record_audiobook(
        db,
        md5=md5,
        container_type=container_type,
        folder_path=folder_path or f"audiobooks/{md5}",
        total_duration_seconds=total_duration_seconds,
        track_count=track_count,
        status=status,
        error_message="boom" if status == "error" else None,
    )


def _seed_mixed(db: str) -> None:
    """Books, ready + processing audiobooks, incomplete download."""
    _complete_book(
        db,
        _BOOK_A,
        "Pride and Prejudice",
        author="Jane Austen",
        year=1813,
        extension="epub",
        content_type="fiction",
        language="English",
        publisher="T. Egerton",
        cover_url="https://example.com/pride.jpg",
    )
    _complete_book(
        db,
        _BOOK_B,
        "Principia",
        author="Isaac Newton",
        year=1687,
        extension="pdf",
        content_type="non-fiction",
        language="Latin",
    )
    _complete_book(
        db,
        _BOOK_C,
        "Untitled Fragment",
        # missing optional metadata intentionally
        media_type=None,  # NULL → book via backfill policy
    )
    _complete_audiobook(
        db,
        _AUDIO_READY,
        "The Hobbit Audio",
        status="ready",
        author="J.R.R. Tolkien",
        content_type="fiction",
        language="English",
        track_count=12,
        total_duration_seconds=36000.0,
        cover_url="https://example.com/hobbit.jpg",
    )
    _complete_audiobook(
        db,
        _AUDIO_PROC,
        "Processing Tale",
        status="processing",
        author="Someone",
        track_count=None,
        total_duration_seconds=None,
    )
    # Non-completed must never appear
    record_download_start(db, md5=_INCOMPLETE, title="In Progress")


# ---------------------------------------------------------------------------
# Schema ownership — query path must not migrate
# ---------------------------------------------------------------------------


class TestQueryPathDoesNotLazyMigrate:
    def test_query_library_fails_without_schema_and_does_not_migrate(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "bare_library.db")
        with patch("src.migrations.run_migrations") as mock_mig, pytest.raises(sqlite3.OperationalError):
            query_library(db_path)
        mock_mig.assert_not_called()
        with sqlite3.connect(db_path) as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "downloads" not in tables


# ---------------------------------------------------------------------------
# Core identity + variants
# ---------------------------------------------------------------------------


class TestLibraryItems:
    def test_should_return_empty_library_when_no_completed(self, lib_db: str) -> None:
        result = query_library(lib_db)
        assert result["items"] == []
        assert result["total_eligible"] == 0
        assert result["filtered_count"] == 0
        assert result["facets"] == {
            "content_types": [],
            "extensions": [],
            "languages": [],
        }

    def test_should_exclude_non_completed_downloads(self, lib_db: str) -> None:
        record_download_start(lib_db, md5=_INCOMPLETE, title="In Progress")
        record_download_start(lib_db, md5=_BOOK_A, title="Failed")
        record_download_failed(lib_db, md5=_BOOK_A, error="nope")
        _complete_book(lib_db, _BOOK_B, "Done")

        result = query_library(lib_db)
        assert result["total_eligible"] == 1
        assert result["items"][0]["md5"] == _BOOK_B

    def test_should_tag_book_and_audiobook_variants(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_ALL)

        by_md5 = {item["md5"]: item for item in result["items"]}
        book = by_md5[_BOOK_A]
        assert book["variant"] == VARIANT_BOOK
        assert book["media_type"] == VARIANT_BOOK
        assert book["title"] == "Pride and Prejudice"
        assert book["author"] == "Jane Austen"
        assert book["cover_url"] == "https://example.com/pride.jpg"
        assert book["extension"] == "epub"
        assert book["language"] == "English"
        assert book["content_type"] == "fiction"
        assert book["publisher"] == "T. Egerton"
        assert book["filesize_bytes"] == 1000
        assert book["completed_at"] is not None
        # Book variant: audiobook fields are null
        assert book["status"] is None
        assert book["track_count"] is None

        audio = by_md5[_AUDIO_READY]
        assert audio["variant"] == VARIANT_AUDIOBOOK
        assert audio["media_type"] == VARIANT_AUDIOBOOK
        assert audio["title"] == "The Hobbit Audio"
        assert audio["status"] == "ready"
        assert audio["track_count"] == 12
        assert audio["total_duration_seconds"] == 36000.0
        assert audio["container_type"] == "zip"
        assert audio["folder_path"] == f"audiobooks/{_AUDIO_READY}"
        assert audio["error_message"] is None

        processing = by_md5[_AUDIO_PROC]
        assert processing["variant"] == VARIANT_AUDIOBOOK
        assert processing["status"] == "processing"

    def test_should_treat_null_media_type_as_book(self, lib_db: str) -> None:
        _complete_book(lib_db, _BOOK_C, "Legacy", media_type=None)
        result = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS)
        assert len(result["items"]) == 1
        assert result["items"][0]["variant"] == VARIANT_BOOK
        assert result["items"][0]["media_type"] == VARIANT_BOOK

    def test_should_classify_by_authoritative_media_type(self, lib_db: str) -> None:
        _complete_book(lib_db, _BOOK_A, "Was Book", media_type="book")
        set_media_type(_BOOK_A, "audiobook", lib_db)
        record_audiobook(lib_db, md5=_BOOK_A, status="ready", track_count=1)

        books = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS)
        audios = query_library(lib_db, media_kind=MEDIA_KIND_AUDIOBOOKS)
        assert books["items"] == []
        assert len(audios["items"]) == 1
        assert audios["items"][0]["md5"] == _BOOK_A


# ---------------------------------------------------------------------------
# Media kind + filters
# ---------------------------------------------------------------------------


class TestFilters:
    def test_should_filter_books_media_kind(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS)
        md5s = {i["md5"] for i in result["items"]}
        assert md5s == {_BOOK_A, _BOOK_B, _BOOK_C}
        assert all(i["variant"] == VARIANT_BOOK for i in result["items"])

    def test_should_filter_audiobooks_media_kind(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_AUDIOBOOKS)
        md5s = {i["md5"] for i in result["items"]}
        assert md5s == {_AUDIO_READY, _AUDIO_PROC}
        assert all(i["variant"] == VARIANT_AUDIOBOOK for i in result["items"])

    def test_should_filter_by_content_type(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS, content_type="fiction")
        assert [i["md5"] for i in result["items"]] == [_BOOK_A]

    def test_should_filter_by_extension(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS, extension="pdf")
        assert [i["md5"] for i in result["items"]] == [_BOOK_B]

    def test_should_filter_by_language(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS, language="Latin")
        assert [i["md5"] for i in result["items"]] == [_BOOK_B]

    def test_should_combine_filters(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(
            lib_db,
            media_kind=MEDIA_KIND_BOOKS,
            content_type="fiction",
            extension="epub",
            language="English",
        )
        assert [i["md5"] for i in result["items"]] == [_BOOK_A]

    def test_should_treat_blank_filter_as_no_filter(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS, content_type="", extension="  ")
        assert result["filtered_count"] == result["total_eligible"] == 3


# ---------------------------------------------------------------------------
# Facets + empty vs no-match
# ---------------------------------------------------------------------------


class TestFacetsAndCounts:
    def test_should_derive_facets_from_eligible_not_filtered(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        result = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS, content_type="fiction")
        # Filter leaves one item, but facets still list all book values.
        assert result["filtered_count"] == 1
        assert result["total_eligible"] == 3
        assert result["facets"]["content_types"] == ["fiction", "non-fiction"]
        assert result["facets"]["extensions"] == ["epub", "pdf"]
        assert result["facets"]["languages"] == ["English", "Latin"]

    def test_should_scope_facets_to_media_kind(self, lib_db: str) -> None:
        _seed_mixed(lib_db)
        books = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS)
        audios = query_library(lib_db, media_kind=MEDIA_KIND_AUDIOBOOKS)
        assert "pdf" in books["facets"]["extensions"]
        assert "pdf" not in audios["facets"]["extensions"]
        assert "zip" in audios["facets"]["extensions"]

    def test_should_distinguish_empty_library_from_no_match(self, lib_db: str) -> None:
        empty = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS, content_type="x")
        assert empty["total_eligible"] == 0
        assert empty["filtered_count"] == 0

        _seed_mixed(lib_db)
        no_match = query_library(lib_db, media_kind=MEDIA_KIND_BOOKS, content_type="comic")
        assert no_match["total_eligible"] == 3
        assert no_match["filtered_count"] == 0
        assert no_match["items"] == []


# ---------------------------------------------------------------------------
# Sort + stable ties
# ---------------------------------------------------------------------------


class TestSort:
    def test_should_sort_by_author_ascending(self, lib_db: str) -> None:
        _complete_book(lib_db, _BOOK_A, "B Title", author="Zed")
        _complete_book(lib_db, _BOOK_B, "A Title", author="Amy")
        result = query_library(lib_db, sort=SORT_AUTHOR)
        assert [i["author"] for i in result["items"]] == ["Amy", "Zed"]

    def test_should_sort_by_title_ascending(self, lib_db: str) -> None:
        _complete_book(lib_db, _BOOK_A, "Zebra")
        _complete_book(lib_db, _BOOK_B, "Apple")
        result = query_library(lib_db, sort=SORT_TITLE)
        assert [i["title"] for i in result["items"]] == ["Apple", "Zebra"]

    def test_should_sort_by_year_newest_first_nulls_last(self, lib_db: str) -> None:
        _complete_book(lib_db, _BOOK_A, "Old", year=1800)
        _complete_book(lib_db, _BOOK_B, "New", year=2020)
        _complete_book(lib_db, _BOOK_C, "No Year", year=None)
        result = query_library(lib_db, sort=SORT_YEAR)
        assert [i["title"] for i in result["items"]] == ["New", "Old", "No Year"]

    def test_should_sort_by_recent_completed_at_desc(self, lib_db: str) -> None:
        for md5, title in [(_BOOK_A, "First"), (_BOOK_B, "Second"), (_BOOK_C, "Third")]:
            _complete_book(lib_db, md5, title)
        result = query_library(lib_db, sort=SORT_RECENT)
        assert [i["title"] for i in result["items"]] == ["Third", "Second", "First"]

    def test_should_use_stable_md5_tiebreaker_for_identical_sort_keys(self, lib_db: str) -> None:
        # Same author → order by md5 ascending
        _complete_book(lib_db, _BOOK_C, "C", author="Same")
        _complete_book(lib_db, _BOOK_A, "A", author="Same")
        _complete_book(lib_db, _BOOK_B, "B", author="Same")
        result = query_library(lib_db, sort=SORT_AUTHOR)
        assert [i["md5"] for i in result["items"]] == [_BOOK_A, _BOOK_B, _BOOK_C]

    def test_should_reject_invalid_sort_and_media_kind(self, lib_db: str) -> None:
        with pytest.raises(ValueError, match="sort"):
            query_library(lib_db, sort="popularity")
        with pytest.raises(ValueError, match="media_kind"):
            query_library(lib_db, media_kind="comics")
