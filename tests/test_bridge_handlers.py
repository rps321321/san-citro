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


def test_handle_list_library_returns_rows():
    fake_rows = [
        {
            "md5": "a" * 32,
            "title": "Test Book",
            "filename": "test.epub",
            "author": "Author A",
            "year": "2020",
            "extension": "epub",
            "content_type": "book",
            "language": "en",
            "publisher": "Publisher X",
            "cover_url": "https://example.com/cover.jpg",
            "filesize_bytes": 1024,
            "completed_at": "2024-01-01T00:00:00",
        }
    ]

    with (
        patch.object(bridge_handlers, "list_library", return_value=fake_rows),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
    ):
        result = bridge_handlers.handle_list_library({})

    assert result == fake_rows
    assert result[0]["md5"] == "a" * 32


def test_handle_list_library_propagates_error():
    import pytest

    with (
        patch.object(bridge_handlers, "list_library", side_effect=OSError("db gone")),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        pytest.raises(RuntimeError, match="Failed to retrieve library"),
    ):
        bridge_handlers.handle_list_library({})


# ---------------------------------------------------------------------------
# handle_list_audiobooks
# ---------------------------------------------------------------------------


def test_handle_list_audiobooks_returns_rows():
    fake_rows = [
        {
            "md5": "b" * 32,
            "title": "Great Audiobook",
            "cover_url": "https://example.com/cover.jpg",
            "status": "ready",
            "container_type": "zip",
            "track_count": 12,
            "total_duration_seconds": 36000.0,
            "error_message": None,
        }
    ]

    with (
        patch.object(bridge_handlers, "list_audiobooks", return_value=fake_rows),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
    ):
        result = bridge_handlers.handle_list_audiobooks({})

    assert result == fake_rows
    assert result[0]["md5"] == "b" * 32
    assert result[0]["status"] == "ready"


def test_handle_list_audiobooks_propagates_error():
    import pytest

    with (
        patch.object(bridge_handlers, "list_audiobooks", side_effect=OSError("db gone")),
        patch.object(bridge_handlers, "_get_history_db", return_value=None),
        pytest.raises(RuntimeError, match="Failed to retrieve audiobooks"),
    ):
        bridge_handlers.handle_list_audiobooks({})


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
