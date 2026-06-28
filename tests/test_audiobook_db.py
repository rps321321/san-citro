"""Tests for src/audiobook_db.py"""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from pathlib import Path

from src.audiobook_db import (
    _ensure_audiobook_tables,
    add_bookmark,
    delete_audiobook,
    delete_bookmark,
    get_audiobook,
    get_audiobook_chapters,
    get_audiobook_progress,
    get_chapter,
    list_audiobooks,
    list_bookmarks,
    record_audiobook,
    replace_chapters,
    reset_stuck_audiobooks,
    save_audiobook_progress,
    set_audiobook_status,
)
from src.download_history import _connect, record_download_complete, record_download_start

_MD5 = "a" * 32


@pytest.fixture()
def audio_db(tmp_path: Path) -> str:
    """Provide a temporary SQLite database path for each test."""
    return str(tmp_path / "test_audiobooks.db")


def _sample_chapters() -> list[dict[str, object]]:
    return [
        {
            "chapter_index": 1,
            "rel_path": "01.mp3",
            "file_size": 1000,
            "title": "Intro",
            "start_offset_seconds": 0,
            "duration_seconds": 60.0,
        },
        {
            "chapter_index": 0,
            "rel_path": "00.mp3",
            "file_size": 500,
            "title": "Cover",
            "start_offset_seconds": 0,
            "duration_seconds": 5.0,
        },
        {
            "chapter_index": 2,
            "rel_path": "02.mp3",
            "file_size": 2000,
            "title": "Chapter 2",
            "start_offset_seconds": 65.0,
            "duration_seconds": 120.0,
        },
    ]


class TestEnsureTables:
    def test_should_create_all_four_tables_when_database_is_new(self, audio_db: str) -> None:
        _ensure_audiobook_tables(audio_db)

        with sqlite3.connect(audio_db) as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

        assert {"audiobooks", "audiobook_chapters", "audiobook_progress", "audiobook_bookmarks"} <= tables

    def test_should_be_idempotent_when_called_twice(self, audio_db: str) -> None:
        _ensure_audiobook_tables(audio_db)
        _ensure_audiobook_tables(audio_db)
        # No exception means success.

    def test_should_create_lookup_indexes(self, audio_db: str) -> None:
        _ensure_audiobook_tables(audio_db)
        with sqlite3.connect(audio_db) as conn:
            indexes = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert {"idx_chapters_md5", "idx_bookmarks_md5"} <= indexes


class TestForeignKeysEnabled:
    def test_should_enable_foreign_keys_on_shared_connection(self, audio_db: str) -> None:
        # The FK cascades in this module depend on download_history._connect
        # setting PRAGMA foreign_keys = ON (shared-contract point 1).
        with _connect(audio_db) as conn:
            assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


class TestRecordAudiobook:
    def test_should_insert_row_when_new_md5(self, audio_db: str) -> None:
        record_audiobook(
            audio_db,
            md5=_MD5,
            container_type="zip",
            folder_path="/extracted/abc",
            total_duration_seconds=185.0,
            track_count=3,
        )

        book = get_audiobook(audio_db, _MD5)
        assert book is not None
        assert book["container_type"] == "zip"
        assert book["folder_path"] == "/extracted/abc"
        assert book["total_duration_seconds"] == 185.0
        assert book["track_count"] == 3
        assert book["status"] == "pending"
        assert book["created_at"] is not None
        assert book["updated_at"] is not None

    def test_should_upsert_when_md5_exists(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5, container_type="zip", track_count=1, status="pending")
        record_audiobook(audio_db, md5=_MD5, container_type="rar", track_count=9, status="ready")

        book = get_audiobook(audio_db, _MD5)
        assert book is not None
        assert book["container_type"] == "rar"
        assert book["track_count"] == 9
        assert book["status"] == "ready"

    def test_should_skip_when_md5_is_empty(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5="", container_type="zip")
        assert list_audiobooks(audio_db) == []

    def test_should_reject_invalid_status_via_check_constraint(self, audio_db: str) -> None:
        with pytest.raises(sqlite3.IntegrityError):
            record_audiobook(audio_db, md5=_MD5, status="bogus")

    def test_should_return_none_when_md5_unknown(self, audio_db: str) -> None:
        _ensure_audiobook_tables(audio_db)
        assert get_audiobook(audio_db, "nope") is None


class TestSetAudiobookStatus:
    def test_should_update_status_and_error_message(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        set_audiobook_status(audio_db, md5=_MD5, status="error", error_message="boom")

        book = get_audiobook(audio_db, _MD5)
        assert book is not None
        assert book["status"] == "error"
        assert book["error_message"] == "boom"

    def test_should_clear_error_when_set_without_message(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        set_audiobook_status(audio_db, md5=_MD5, status="error", error_message="boom")
        set_audiobook_status(audio_db, md5=_MD5, status="ready")

        book = get_audiobook(audio_db, _MD5)
        assert book is not None
        assert book["status"] == "ready"
        assert book["error_message"] is None


class TestReplaceChapters:
    def test_should_insert_chapters_ordered_by_index(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())

        chapters = get_audiobook_chapters(audio_db, _MD5)
        assert [c["chapter_index"] for c in chapters] == [0, 1, 2]
        assert [c["rel_path"] for c in chapters] == ["00.mp3", "01.mp3", "02.mp3"]

    def test_should_replace_existing_chapters(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())
        replace_chapters(
            audio_db,
            md5=_MD5,
            chapters=[{"chapter_index": 0, "rel_path": "only.mp3"}],
        )

        chapters = get_audiobook_chapters(audio_db, _MD5)
        assert len(chapters) == 1
        assert chapters[0]["rel_path"] == "only.mp3"

    def test_should_default_optional_fields(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=[{"chapter_index": 0, "rel_path": "a.mp3"}])

        chapter = get_audiobook_chapters(audio_db, _MD5)[0]
        assert chapter["file_size"] is None
        assert chapter["title"] is None
        assert chapter["duration_seconds"] is None
        assert chapter["start_offset_seconds"] == 0

    def test_should_clear_chapters_when_given_empty_list(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())
        replace_chapters(audio_db, md5=_MD5, chapters=[])
        assert get_audiobook_chapters(audio_db, _MD5) == []

    def test_should_be_atomic_on_duplicate_index(self, audio_db: str) -> None:
        # A duplicate (md5, chapter_index) violates the UNIQUE constraint; the
        # whole replace must roll back, leaving the prior chapters intact.
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())

        bad = [
            {"chapter_index": 0, "rel_path": "x.mp3"},
            {"chapter_index": 0, "rel_path": "y.mp3"},
        ]
        with pytest.raises(sqlite3.IntegrityError):
            replace_chapters(audio_db, md5=_MD5, chapters=bad)

        # Original three chapters survive the failed replace.
        assert len(get_audiobook_chapters(audio_db, _MD5)) == 3


class TestGetChapter:
    def test_should_return_chapter_by_id(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())

        target = get_audiobook_chapters(audio_db, _MD5)[1]  # chapter_index 1
        fetched = get_chapter(audio_db, target["chapter_id"])

        assert fetched is not None
        assert fetched["chapter_id"] == target["chapter_id"]
        assert fetched["rel_path"] == "01.mp3"

    def test_should_return_none_when_chapter_id_unknown(self, audio_db: str) -> None:
        _ensure_audiobook_tables(audio_db)
        assert get_chapter(audio_db, 999999) is None


class TestListAudiobooks:
    def test_should_left_join_download_title_and_cover(self, audio_db: str) -> None:
        record_download_start(
            audio_db,
            md5=_MD5,
            title="The Hobbit",
            meta={"cover_url": "https://example.com/hobbit.jpg"},
        )
        record_download_complete(audio_db, md5=_MD5, filename="hobbit.zip", filesize_bytes=10)
        record_audiobook(audio_db, md5=_MD5, container_type="zip")

        items = list_audiobooks(audio_db)
        assert len(items) == 1
        assert items[0]["title"] == "The Hobbit"
        assert items[0]["cover_url"] == "https://example.com/hobbit.jpg"

    def test_should_include_audiobook_with_no_download_row(self, audio_db: str) -> None:
        # LEFT JOIN: an audiobook with no matching downloads row still appears.
        record_audiobook(audio_db, md5=_MD5, container_type="zip")
        items = list_audiobooks(audio_db)
        assert len(items) == 1
        assert items[0]["title"] is None
        assert items[0]["cover_url"] is None

    def test_should_return_empty_list_when_none_recorded(self, audio_db: str) -> None:
        assert list_audiobooks(audio_db) == []


class TestProgress:
    def test_should_save_and_restore_progress_keyed_by_chapter_id(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())
        chapter_id = get_audiobook_chapters(audio_db, _MD5)[2]["chapter_id"]

        save_audiobook_progress(audio_db, md5=_MD5, chapter_id=chapter_id, file_position_seconds=42.5)

        progress = get_audiobook_progress(audio_db, _MD5)
        assert progress is not None
        assert progress["chapter_id"] == chapter_id
        assert progress["file_position_seconds"] == 42.5
        assert progress["updated_at"] is not None

    def test_should_upsert_progress_on_repeated_save(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        save_audiobook_progress(audio_db, md5=_MD5, chapter_id=None, file_position_seconds=1.0)
        save_audiobook_progress(audio_db, md5=_MD5, chapter_id=None, file_position_seconds=99.0)

        progress = get_audiobook_progress(audio_db, _MD5)
        assert progress is not None
        assert progress["file_position_seconds"] == 99.0

    def test_should_return_none_when_no_progress(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        assert get_audiobook_progress(audio_db, _MD5) is None

    def test_should_null_chapter_id_when_chapter_deleted(self, audio_db: str) -> None:
        # audiobook_progress.chapter_id is ON DELETE SET NULL.
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())
        chapter_id = get_audiobook_chapters(audio_db, _MD5)[0]["chapter_id"]
        save_audiobook_progress(audio_db, md5=_MD5, chapter_id=chapter_id, file_position_seconds=3.0)

        # Re-extraction wipes & re-inserts chapters, dropping the old id.
        replace_chapters(audio_db, md5=_MD5, chapters=[{"chapter_index": 0, "rel_path": "new.mp3"}])

        progress = get_audiobook_progress(audio_db, _MD5)
        assert progress is not None
        assert progress["chapter_id"] is None
        assert progress["file_position_seconds"] == 3.0


class TestBookmarks:
    def test_should_add_and_list_bookmarks_oldest_first(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        first = add_bookmark(audio_db, md5=_MD5, file_position_seconds=10.0, label="A")
        second = add_bookmark(audio_db, md5=_MD5, file_position_seconds=20.0, label="B")

        bookmarks = list_bookmarks(audio_db, _MD5)
        assert [b["bookmark_id"] for b in bookmarks] == [first, second]
        assert [b["label"] for b in bookmarks] == ["A", "B"]

    def test_should_return_new_bookmark_id(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        bookmark_id = add_bookmark(audio_db, md5=_MD5, file_position_seconds=5.0)
        assert isinstance(bookmark_id, int)
        assert bookmark_id > 0

    def test_should_delete_bookmark_owned_by_md5(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        bookmark_id = add_bookmark(audio_db, md5=_MD5, file_position_seconds=5.0)
        delete_bookmark(audio_db, md5=_MD5, bookmark_id=bookmark_id)
        assert list_bookmarks(audio_db, _MD5) == []

    def test_should_not_delete_bookmark_owned_by_other_md5(self, audio_db: str) -> None:
        other = "b" * 32
        record_audiobook(audio_db, md5=_MD5)
        record_audiobook(audio_db, md5=other)
        bookmark_id = add_bookmark(audio_db, md5=_MD5, file_position_seconds=5.0)

        # Ownership check: deleting via the wrong md5 is a no-op.
        delete_bookmark(audio_db, md5=other, bookmark_id=bookmark_id)

        assert len(list_bookmarks(audio_db, _MD5)) == 1

    def test_should_return_empty_list_when_no_bookmarks(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        assert list_bookmarks(audio_db, _MD5) == []


class TestDeleteAudiobookCascade:
    def test_should_cascade_delete_chapters_progress_and_bookmarks(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5)
        replace_chapters(audio_db, md5=_MD5, chapters=_sample_chapters())
        chapter_id = get_audiobook_chapters(audio_db, _MD5)[0]["chapter_id"]
        save_audiobook_progress(audio_db, md5=_MD5, chapter_id=chapter_id, file_position_seconds=1.0)
        add_bookmark(audio_db, md5=_MD5, file_position_seconds=2.0)

        delete_audiobook(audio_db, md5=_MD5)

        assert get_audiobook(audio_db, _MD5) is None
        # FK ON DELETE CASCADE must have wiped every child row.
        with _connect(audio_db) as conn:
            assert conn.execute("SELECT COUNT(*) FROM audiobook_chapters WHERE md5 = ?", (_MD5,)).fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM audiobook_progress WHERE md5 = ?", (_MD5,)).fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM audiobook_bookmarks WHERE md5 = ?", (_MD5,)).fetchone()[0] == 0

    def test_should_leave_other_audiobooks_intact(self, audio_db: str) -> None:
        other = "b" * 32
        record_audiobook(audio_db, md5=_MD5)
        record_audiobook(audio_db, md5=other)
        replace_chapters(audio_db, md5=other, chapters=_sample_chapters())

        delete_audiobook(audio_db, md5=_MD5)

        assert get_audiobook(audio_db, other) is not None
        assert len(get_audiobook_chapters(audio_db, other)) == 3


class TestResetStuckAudiobooks:
    def test_should_reset_processing_to_pending(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5, status="processing")
        count = reset_stuck_audiobooks(audio_db)

        assert count == 1
        book = get_audiobook(audio_db, _MD5)
        assert book is not None
        assert book["status"] == "pending"

    def test_should_not_touch_other_statuses(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5="r" * 32, status="ready")
        record_audiobook(audio_db, md5="e" * 32, status="error")
        record_audiobook(audio_db, md5=_MD5, status="processing")

        count = reset_stuck_audiobooks(audio_db)

        assert count == 1
        assert get_audiobook(audio_db, "r" * 32)["status"] == "ready"  # type: ignore[index]
        assert get_audiobook(audio_db, "e" * 32)["status"] == "error"  # type: ignore[index]

    def test_should_return_zero_when_nothing_stuck(self, audio_db: str) -> None:
        record_audiobook(audio_db, md5=_MD5, status="ready")
        assert reset_stuck_audiobooks(audio_db) == 0
