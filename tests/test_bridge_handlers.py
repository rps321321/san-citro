"""Tests for Electron bridge handlers."""

import importlib
import sys
from pathlib import Path
from unittest.mock import patch

BRIDGE_DIR = Path(__file__).resolve().parents[1] / "electron-app" / "python"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

bridge_handlers = importlib.import_module("bridge_handlers")


def test_diagnostics_message_drops_duplicate_check_name():
    message = "Internet Connection: [bold green]ONLINE[/bold green]"

    cleaned = bridge_handlers._redact_sensitive_message("Internet Connection", True, message)

    assert cleaned == "ONLINE"


def test_search_has_next_uses_scraper_page_size():
    rows = [{"md5": f"{i:032x}"} for i in range(20)]

    with (
        patch.object(bridge_handlers, "get_config", return_value={"proxies": [], "history_db": None}),
        patch.object(bridge_handlers, "scrape_annas_archive", return_value=rows),
        patch.object(bridge_handlers, "get_completed_md5s", return_value=set()),
    ):
        result = bridge_handlers.handle_search({"query": "python"})

    assert result["total_count"] == 20
    assert result["has_next"] is False


def test_search_returns_capabilities_and_default_relevance_sort():
    rows = [{"md5": "a" * 32}]

    with (
        patch.object(bridge_handlers, "get_config", return_value={"proxies": [], "history_db": None}),
        patch.object(bridge_handlers, "scrape_annas_archive", return_value=rows) as scrape,
        patch.object(bridge_handlers, "get_completed_md5s", return_value=set()),
    ):
        result = bridge_handlers.handle_search({"query": "python"})

    scrape.assert_called_once()
    assert scrape.call_args.kwargs.get("sort") is None
    assert result["sort"] == ""
    caps = result["capabilities"]
    assert any(s["value"] == "" and s["label"] == "Relevance" for s in caps["sorts"])
    assert any(s["value"] == "newest" for s in caps["sorts"])
    assert any(e["value"] == "epub" for e in caps["extensions"])
    assert any(lang["value"] == "English" for lang in caps["languages"])
    # Product omits unstable random sort.
    assert all(s["value"] != "random" for s in caps["sorts"])


def test_search_forwards_alternate_sort_to_scraper():
    rows = [{"md5": "b" * 32}]

    with (
        patch.object(bridge_handlers, "get_config", return_value={"proxies": [], "history_db": None}),
        patch.object(bridge_handlers, "scrape_annas_archive", return_value=rows) as scrape,
        patch.object(bridge_handlers, "get_completed_md5s", return_value=set()),
    ):
        result = bridge_handlers.handle_search({"query": "python", "sort": "largest", "page": 3})

    assert result["sort"] == "largest"
    assert result["page"] == 3
    assert scrape.call_args.kwargs.get("sort") == "largest"
    assert scrape.call_args.kwargs.get("page") == 3


def test_search_unknown_sort_falls_back_to_relevance():
    rows = [{"md5": "c" * 32}]

    with (
        patch.object(bridge_handlers, "get_config", return_value={"proxies": [], "history_db": None}),
        patch.object(bridge_handlers, "scrape_annas_archive", return_value=rows) as scrape,
        patch.object(bridge_handlers, "get_completed_md5s", return_value=set()),
    ):
        result = bridge_handlers.handle_search({"query": "python", "sort": "title_asc"})

    assert result["sort"] == ""
    assert scrape.call_args.kwargs.get("sort") is None


def test_handle_list_library_returns_query_result():
    fake_result = {
        "items": [
            {
                "md5": "a" * 32,
                "title": "Test Book",
                "filename": "test.epub",
                "author": "Author A",
                "year": 2020,
                "extension": "epub",
                "content_type": "fiction",
                "language": "en",
                "publisher": "Publisher X",
                "cover_url": "https://example.com/cover.jpg",
                "filesize_bytes": 1024,
                "completed_at": "2024-01-01T00:00:00",
                "media_type": "book",
                "variant": "book",
                "status": None,
                "container_type": None,
                "folder_path": None,
                "total_duration_seconds": None,
                "track_count": None,
                "error_message": None,
            }
        ],
        "facets": {
            "content_types": ["fiction"],
            "extensions": ["epub"],
            "languages": ["en"],
        },
        "total_eligible": 1,
        "filtered_count": 1,
    }

    with (
        patch.object(bridge_handlers, "query_library", return_value=fake_result) as mock_q,
        patch.object(bridge_handlers, "_get_history_db", return_value="/tmp/history.db"),
    ):
        result = bridge_handlers.handle_list_library(
            {
                "media_kind": "books",
                "sort": "author",
                "content_type": "fiction",
                "extension": "epub",
                "language": "en",
            }
        )

    assert result == fake_result
    assert result["items"][0]["md5"] == "a" * 32
    mock_q.assert_called_once_with(
        db_path="/tmp/history.db",
        media_kind="books",
        content_type="fiction",
        extension="epub",
        language="en",
        sort="author",
    )


def test_handle_list_library_defaults_when_params_empty():
    fake_result = {
        "items": [],
        "facets": {"content_types": [], "extensions": [], "languages": []},
        "total_eligible": 0,
        "filtered_count": 0,
    }

    with (
        patch.object(bridge_handlers, "query_library", return_value=fake_result) as mock_q,
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
    ):
        result = bridge_handlers.handle_list_library({})

    assert result == fake_result
    mock_q.assert_called_once_with(
        db_path=None,
        media_kind="all",
        content_type=None,
        extension=None,
        language=None,
        sort="recent",
    )


def test_handle_list_library_propagates_error():
    import pytest

    with (
        patch.object(bridge_handlers, "query_library", side_effect=OSError("db gone")),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        pytest.raises(RuntimeError, match="Failed to retrieve library"),
    ):
        bridge_handlers.handle_list_library({})


def test_handle_list_library_propagates_value_error():
    import pytest

    with (
        patch.object(
            bridge_handlers, "query_library", side_effect=ValueError("Invalid sort")
        ),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        pytest.raises(ValueError, match="Invalid sort"),
    ):
        bridge_handlers.handle_list_library({"sort": "nope"})


def test_handle_list_library_returns_unified_variants_from_sqlite(tmp_path):
    """End-to-end: SQLite → query_library → list_library bridge (no dual path).

    Proves Book/Audiobook discrimination via authoritative media_type, with
    Book-specific vs Audiobook-specific fields, while detail/player stay separate
    commands (list_library is the sole Library collection path).
    """
    from src.audiobook_db import record_audiobook
    from src.download_history import record_download_complete, record_download_start
    from src.migrations import run_migrations

    db_path = str(tmp_path / "library_e2e.db")
    run_migrations(db_path)

    book_md5 = "a" * 32
    audio_md5 = "b" * 32

    record_download_start(
        db_path,
        md5=book_md5,
        title="Pride and Prejudice",
        meta={
            "author": "Jane Austen",
            "year": 1813,
            "extension": "epub",
            "content_type": "fiction",
            "language": "English",
            "publisher": "T. Egerton",
            "cover_url": "https://example.com/pride.jpg",
            "media_type": "book",
        },
    )
    record_download_complete(
        db_path, md5=book_md5, filename="pride.epub", filesize_bytes=512000
    )

    record_download_start(
        db_path,
        md5=audio_md5,
        title="The Hobbit Audio",
        meta={
            "author": "Tolkien",
            "extension": "zip",
            "media_type": "audiobook",
        },
    )
    record_download_complete(
        db_path, md5=audio_md5, filename="hobbit.zip", filesize_bytes=9000
    )
    record_audiobook(
        db_path,
        md5=audio_md5,
        container_type="zip",
        folder_path=f"audiobooks/{audio_md5}",
        total_duration_seconds=3600.0,
        track_count=12,
        status="ready",
    )

    with patch.object(bridge_handlers, "_get_history_db", return_value=db_path):
        result = bridge_handlers.handle_list_library({"media_kind": "all", "sort": "title"})

    assert result["total_eligible"] == 2
    assert result["filtered_count"] == 2
    by_md5 = {item["md5"]: item for item in result["items"]}

    book = by_md5[book_md5]
    assert book["variant"] == "book"
    assert book["media_type"] == "book"
    assert book["extension"] == "epub"
    assert book["language"] == "English"
    assert book["content_type"] == "fiction"
    assert book["publisher"] == "T. Egerton"
    assert book["status"] is None
    assert book["track_count"] is None
    assert book["total_duration_seconds"] is None

    audio = by_md5[audio_md5]
    assert audio["variant"] == "audiobook"
    assert audio["media_type"] == "audiobook"
    assert audio["status"] == "ready"
    assert audio["track_count"] == 12
    assert audio["total_duration_seconds"] == 3600.0
    assert audio["container_type"] == "zip"
    assert audio["folder_path"] == f"audiobooks/{audio_md5}"

    # media_type authority: media_kind filter uses backend classification
    with patch.object(bridge_handlers, "_get_history_db", return_value=db_path):
        books_only = bridge_handlers.handle_list_library({"media_kind": "books"})
        audios_only = bridge_handlers.handle_list_library({"media_kind": "audiobooks"})
    assert [i["md5"] for i in books_only["items"]] == [book_md5]
    assert [i["md5"] for i in audios_only["items"]] == [audio_md5]


def test_handle_list_library_uses_query_library_not_download_history():
    """Regression: Library page path must not call download_history.list_library."""
    import inspect

    import src.download_history as download_history
    import src.library as library_mod

    assert not hasattr(download_history, "list_library"), (
        "download_history.list_library was removed; Library uses src.library.query_library"
    )
    assert hasattr(library_mod, "query_library")
    # Handler is bound to the deep-module query, not a history list.
    assert bridge_handlers.query_library is library_mod.query_library
    source = inspect.getsource(bridge_handlers.handle_list_library)
    assert "query_library" in source
    assert "download_history.list_library" not in source


# ---------------------------------------------------------------------------
# handle_get_audiobook_detail
# ---------------------------------------------------------------------------

_VALID_MD5 = "c" * 32


def test_handle_get_audiobook_detail_returns_audiobook_and_chapters():
    fake_audiobook = {
        "md5": _VALID_MD5,
        "status": "ready",
        "container_type": "zip",
        "track_count": 3,
        "total_duration_seconds": 10800.0,
        "error_message": None,
    }
    fake_chapters = [
        {
            "chapter_id": 1,
            "chapter_index": 0,
            "title": "Chapter 1",
            "rel_path": "track01.mp3",
            "start_offset_seconds": 0.0,
            "duration_seconds": 3600.0,
        },
    ]

    with (
        patch.object(bridge_handlers, "get_audiobook", return_value=fake_audiobook),
        patch.object(bridge_handlers, "get_audiobook_chapters", return_value=fake_chapters),
        patch.object(
            bridge_handlers,
            "get_completed_download",
            return_value={"title": "HHGTTG", "cover_url": "https://x/c.jpg"},
        ),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
    ):
        result = bridge_handlers.handle_get_audiobook_detail({"md5": _VALID_MD5})

    # The download row supplies title + cover the audiobooks table lacks.
    assert result["audiobook"]["title"] == "HHGTTG"
    assert result["audiobook"]["cover_url"] == "https://x/c.jpg"
    assert result["chapters"] == fake_chapters


def test_handle_get_audiobook_detail_none_when_missing():
    with (
        patch.object(bridge_handlers, "get_audiobook", return_value=None),
        patch.object(bridge_handlers, "get_audiobook_chapters", return_value=[]),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
    ):
        result = bridge_handlers.handle_get_audiobook_detail({"md5": _VALID_MD5})

    assert result["audiobook"] is None
    assert result["chapters"] == []


def test_handle_get_audiobook_detail_rejects_bad_md5():
    import pytest

    with pytest.raises(ValueError, match="Invalid md5"):
        bridge_handlers.handle_get_audiobook_detail({"md5": "not-an-md5"})


def test_handle_get_audiobook_detail_propagates_error():
    import pytest

    with (
        patch.object(bridge_handlers, "get_audiobook", side_effect=OSError("db gone")),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        pytest.raises(RuntimeError, match="Failed to retrieve audiobook detail"),
    ):
        bridge_handlers.handle_get_audiobook_detail({"md5": _VALID_MD5})


# ---------------------------------------------------------------------------
# handle_get_chapter_path
# ---------------------------------------------------------------------------


def test_handle_get_chapter_path_returns_path(tmp_path):
    """Happy path: valid ownership + containment + existing file."""
    md5 = "d" * 32
    audio_file = tmp_path / "audiobooks" / md5 / "track01.mp3"
    audio_file.parent.mkdir(parents=True)
    audio_file.write_bytes(b"")

    fake_chapter = {
        "chapter_id": 1,
        "md5": md5,
        "rel_path": f"audiobooks/{md5}/track01.mp3",
    }

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "get_chapter", return_value=fake_chapter),
        patch.object(bridge_handlers, "get_config", return_value={"out_dir": str(tmp_path)}),
        patch.object(bridge_handlers, "validate_writable_dir", side_effect=lambda d: d),
    ):
        result = bridge_handlers.handle_get_chapter_path({"md5": md5, "chapter_id": 1})

    import os

    assert result == os.path.realpath(str(audio_file))


def test_handle_get_chapter_path_rejects_wrong_ownership(tmp_path):
    """Chapter row md5 differs from requested md5 -> None."""
    md5 = "e" * 32
    other_md5 = "f" * 32

    fake_chapter = {
        "chapter_id": 2,
        "md5": other_md5,
        "rel_path": f"audiobooks/{other_md5}/track01.mp3",
    }

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "get_chapter", return_value=fake_chapter),
        patch.object(bridge_handlers, "get_config", return_value={"out_dir": str(tmp_path)}),
        patch.object(bridge_handlers, "validate_writable_dir", side_effect=lambda d: d),
    ):
        result = bridge_handlers.handle_get_chapter_path({"md5": md5, "chapter_id": 2})

    assert result is None


def test_handle_get_chapter_path_rejects_path_escape(tmp_path):
    """rel_path that escapes out_dir via ../ -> None."""
    md5 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"

    fake_chapter = {
        "chapter_id": 3,
        "md5": md5,
        "rel_path": "../../etc/passwd",
    }

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "get_chapter", return_value=fake_chapter),
        patch.object(bridge_handlers, "get_config", return_value={"out_dir": str(tmp_path)}),
        patch.object(bridge_handlers, "validate_writable_dir", side_effect=lambda d: d),
    ):
        result = bridge_handlers.handle_get_chapter_path({"md5": md5, "chapter_id": 3})

    assert result is None


def test_handle_get_chapter_path_returns_none_when_missing(tmp_path):
    """Chapter row exists but file is absent -> None."""
    md5 = "1234567890abcdef1234567890abcdef"
    fake_chapter = {
        "chapter_id": 4,
        "md5": md5,
        "rel_path": f"audiobooks/{md5}/missing.mp3",
    }
    # Ensure the audiobooks dir exists but the file does not.
    (tmp_path / "audiobooks" / md5).mkdir(parents=True)

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "get_chapter", return_value=fake_chapter),
        patch.object(bridge_handlers, "get_config", return_value={"out_dir": str(tmp_path)}),
        patch.object(bridge_handlers, "validate_writable_dir", side_effect=lambda d: d),
    ):
        result = bridge_handlers.handle_get_chapter_path({"md5": md5, "chapter_id": 4})

    assert result is None


def test_handle_get_chapter_path_returns_none_for_unknown_chapter():
    """get_chapter returns None -> handler returns None."""
    md5 = "abcdef1234567890abcdef1234567890"

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "get_chapter", return_value=None),
        patch.object(bridge_handlers, "get_config", return_value={"out_dir": "/tmp/x"}),
        patch.object(bridge_handlers, "validate_writable_dir", side_effect=lambda d: d),
    ):
        result = bridge_handlers.handle_get_chapter_path({"md5": md5, "chapter_id": 99})

    assert result is None


def test_handle_get_chapter_path_rejects_non_int_chapter_id():
    """chapter_id that is not an int raises ValueError."""
    import pytest

    md5 = "abcdef1234567890abcdef1234567890"
    with pytest.raises(ValueError, match="chapter_id must be an integer"):
        bridge_handlers.handle_get_chapter_path({"md5": md5, "chapter_id": "one"})


def test_handle_get_chapter_path_rejects_bad_md5():
    """Bad md5 raises ValueError from _validate_md5."""
    import pytest

    with pytest.raises(ValueError, match="Invalid md5"):
        bridge_handlers.handle_get_chapter_path({"md5": "short", "chapter_id": 1})


# ---------------------------------------------------------------------------
# handle_get_audiobook_progress / handle_save_audiobook_progress
# ---------------------------------------------------------------------------


def test_handle_get_audiobook_progress_returns_row():
    md5 = _VALID_MD5
    fake_progress = {
        "md5": md5,
        "chapter_id": 2,
        "file_position_seconds": 123.4,
        "updated_at": "2026-06-29T00:00:00+00:00",
    }

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "get_audiobook_progress", return_value=fake_progress),
    ):
        result = bridge_handlers.handle_get_audiobook_progress({"md5": md5})

    assert result == fake_progress


def test_handle_get_audiobook_progress_returns_none_when_absent():
    md5 = _VALID_MD5

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "get_audiobook_progress", return_value=None),
    ):
        result = bridge_handlers.handle_get_audiobook_progress({"md5": md5})

    assert result is None


def test_handle_save_audiobook_progress_returns_ok():
    md5 = _VALID_MD5

    with (
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        patch.object(bridge_handlers, "save_audiobook_progress") as mock_save,
    ):
        result = bridge_handlers.handle_save_audiobook_progress(
            {"md5": md5, "chapter_id": 3, "file_position_seconds": 45.6}
        )
        mock_save.assert_called_once_with(db_path=None, md5=md5, chapter_id=3, file_position_seconds=45.6)

    assert result == {"ok": True}


# ---------------------------------------------------------------------------
# Registration test — all three new methods resolve via register_method
# ---------------------------------------------------------------------------


def test_registration_includes_new_audiobook_player_methods():
    """register_handlers must bind all three new player RPC methods."""
    registered: dict[str, object] = {}

    def fake_register(name: str, fn: object) -> None:
        registered[name] = fn

    with patch("bridge.register_method", fake_register):
        bridge_handlers.register_handlers()

    assert "get_chapter_path" in registered, "get_chapter_path not registered"
    assert "get_audiobook_progress" in registered, "get_audiobook_progress not registered"
    assert "save_audiobook_progress" in registered, "save_audiobook_progress not registered"


# Canonical Python-backed method set (must match electron-app/src/python-commands.ts usesMethods).
_EXPECTED_PYTHON_METHODS = frozenset(
    {
        "search",
        "start_download",
        "cancel_download",
        "get_downloads",
        "get_history",
        "get_stats",
        "get_settings",
        "update_settings",
        "reload_config",
        "run_diagnostics",
        "resolve_download_path",
        "set_telemetry_context",
        "list_library",
        # list_audiobooks product RPC retired (#47); DB helper remains internal-only.
        "get_audiobook_detail",
        "get_chapter_path",
        "get_audiobook_progress",
        "save_audiobook_progress",
    }
)


def test_registration_matches_desktop_command_descriptor_set():
    """Python registry must equal the descriptor's usesMethods set (Phase 4 contract)."""
    registered: dict[str, object] = {}

    def fake_register(name: str, fn: object) -> None:
        registered[name] = fn

    with patch("bridge.register_method", fake_register):
        bridge_handlers.register_handlers()

    actual = frozenset(registered)
    missing = _EXPECTED_PYTHON_METHODS - actual
    extra = actual - _EXPECTED_PYTHON_METHODS
    assert not missing, f"Python registry missing methods: {sorted(missing)}"
    assert not extra, f"Python registry has unexpected methods: {sorted(extra)}"
