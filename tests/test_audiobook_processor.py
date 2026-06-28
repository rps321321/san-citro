"""Tests for src/audiobook_processor.py — classification + hardened extraction.

Real binaries (ffmpeg/7z) are used for the end-to-end tests; those skip
gracefully when a binary is absent. The chapter-builder unit tests mock
``probe_media`` so they need no real media.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import zipfile
from typing import TYPE_CHECKING

import pytest

import src.audiobook_db as audiobook_db
from src.audiobook_processor import (
    _build_chapters,
    _build_m4b_chapters,
    _member_is_unsafe,
    _natural_key,
    classify,
    process_audiobook,
    sweep_stale_tmp,
)

if TYPE_CHECKING:
    from pathlib import Path

_MD5 = "a" * 32


# ---------------------------------------------------------------------------
# Binary availability
# ---------------------------------------------------------------------------
def _have_ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def _have_7z() -> bool:
    try:
        from src.media_tools import find_7z

        find_7z()
        return True
    except FileNotFoundError:
        return False


def _make_mp3(path: Path, seconds: int = 1) -> None:
    """Generate a tiny real mp3 via ffmpeg."""
    ffmpeg = _have_ffmpeg()
    assert ffmpeg is not None
    subprocess.run(
        [
            ffmpeg,
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=mono",
            "-t",
            str(seconds),
            "-q:a",
            "9",
            "-y",
            str(path),
        ],
        capture_output=True,
        check=True,
        timeout=60,
    )


@pytest.fixture()
def db_redirect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """Redirect the audiobook DB to a temp file for the whole module chain."""
    db_file = str(tmp_path / "history.db")
    monkeypatch.setattr(
        "src.download_history.get_default_history_db_path",
        lambda: db_file,
    )
    # Clear the lazy-init caches so the fresh temp DB gets its tables.
    audiobook_db._initialized_dbs.clear()
    import src.download_history as dh

    dh._initialized_dbs.clear()
    return db_file


# ---------------------------------------------------------------------------
# natural sort
# ---------------------------------------------------------------------------
class TestNaturalKey:
    def test_should_order_chapter_2_before_chapter_10(self) -> None:
        items = ["chapter 10.mp3", "chapter 2.mp3", "chapter 34 first half.mp3"]
        items.sort(key=_natural_key)
        assert items == ["chapter 2.mp3", "chapter 10.mp3", "chapter 34 first half.mp3"]


# ---------------------------------------------------------------------------
# member-safety unit tests (no binaries needed)
# ---------------------------------------------------------------------------
class TestMemberSafety:
    @pytest.mark.parametrize(
        "member",
        [
            "../evil.txt",
            "a/../../evil.txt",
            "/etc/passwd",
            "C:evil.txt",
            r"C:\evil.txt",
            r"sub\..\..\evil.txt",
            "\\evil.txt",
            "CON",
            "CON.mp3",
            "nul",
            "COM1.txt",
            "LPT9",
            "nested.zip",
            "inner.rar",
            "deep/inner.7z",
            "",
        ],
    )
    def test_should_reject_hostile_members(self, member: str) -> None:
        assert _member_is_unsafe(member) is True

    @pytest.mark.parametrize(
        "member",
        ["chapter 01.mp3", "sub/chapter 02.mp3", "cover.jpg", "Disc 1/track.flac", r"sub\track.mp3"],
    )
    def test_should_accept_safe_members(self, member: str) -> None:
        assert _member_is_unsafe(member) is False


# ---------------------------------------------------------------------------
# classify
# ---------------------------------------------------------------------------
class TestClassify:
    def test_should_classify_single_audio_file_as_audiobook(self) -> None:
        assert classify("/x/book.mp3") == "audiobook"

    def test_should_classify_pdf_as_book(self) -> None:
        assert classify("/x/book.pdf") == "book"

    def test_should_classify_zip_of_pdfs_as_book(self, tmp_path: Path) -> None:
        if not _have_7z():
            pytest.skip("7z not available")
        archive = tmp_path / "books.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("a.pdf", b"%PDF-1.4 fake")
            zf.writestr("b.pdf", b"%PDF-1.4 fake")
        assert classify(str(archive)) == "book"

    def test_should_classify_zip_with_mp3_as_audiobook(self, tmp_path: Path) -> None:
        if not _have_7z():
            pytest.skip("7z not available")
        archive = tmp_path / "ab.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("track.mp3", b"fake")
            zf.writestr("cover.jpg", b"fake")
        assert classify(str(archive)) == "audiobook"


# ---------------------------------------------------------------------------
# chapter builders (mocked probe_media — no real m4b needed)
# ---------------------------------------------------------------------------
class TestChapterBuilders:
    def test_should_build_one_chapter_per_m4b_chapter(self) -> None:
        probe = {
            "format": {"duration": "300.0"},
            "chapters": [
                {"start_time": "0.0", "tags": {"title": "One"}},
                {"start_time": "100.0", "tags": {"title": "Two"}},
                {"start_time": "200.0"},
            ],
        }
        chapters = _build_m4b_chapters("audiobooks/x/book.m4b", probe)
        assert [c["title"] for c in chapters] == ["One", "Two", "Chapter 3"]
        assert [c["start_offset_seconds"] for c in chapters] == [0.0, 100.0, 200.0]
        assert [c["duration_seconds"] for c in chapters] == [100.0, 100.0, 100.0]
        assert all(c["rel_path"] == "audiobooks/x/book.m4b" for c in chapters)

    def test_should_build_single_chapter_for_markerless_m4b(self) -> None:
        probe = {"format": {"duration": "42.0"}, "chapters": []}
        chapters = _build_m4b_chapters("audiobooks/x/book.m4b", probe)
        assert len(chapters) == 1
        assert chapters[0]["duration_seconds"] == 42.0
        assert chapters[0]["start_offset_seconds"] == 0.0

    def test_should_build_n_chapters_for_multi_file(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def fake_probe(path: str) -> dict[str, object]:
            return {"format": {"duration": "12.0", "tags": {"title": f"T-{os.path.basename(path)}"}}}

        monkeypatch.setattr("src.audiobook_processor.media_tools.probe_media", fake_probe)
        audio = [("/abs/a.mp3", "audiobooks/x/a.mp3"), ("/abs/b.mp3", "audiobooks/x/b.mp3")]
        chapters = _build_chapters(audio)
        assert len(chapters) == 2
        assert chapters[0]["chapter_index"] == 0
        assert chapters[1]["chapter_index"] == 1
        assert chapters[0]["duration_seconds"] == 12.0
        assert chapters[0]["title"] == "T-a.mp3"

    def test_should_fall_back_to_filename_stem_when_no_title_tag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "src.audiobook_processor.media_tools.probe_media",
            lambda path: {"format": {"duration": "5.0"}},
        )
        audio = [("/abs/a.mp3", "audiobooks/x/a.mp3"), ("/abs/b.mp3", "audiobooks/x/b.mp3")]
        chapters = _build_chapters(audio)
        assert [c["title"] for c in chapters] == ["a", "b"]


# ---------------------------------------------------------------------------
# end-to-end (real ffmpeg + 7z)
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not _have_ffmpeg() or not _have_7z(), reason="ffmpeg/7z required")
class TestProcessEndToEnd:
    def test_should_process_single_mp3_zip_to_one_ready_chapter(
        self, tmp_path: Path, db_redirect: str
    ) -> None:
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        mp3 = tmp_path / "track.mp3"
        _make_mp3(mp3)
        archive = out_dir / f"{_MD5}.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.write(mp3, "track.mp3")

        status = process_audiobook(_MD5, str(archive), str(out_dir))
        assert status == "ready"

        row = audiobook_db.get_audiobook(md5=_MD5)
        assert row is not None
        assert row["status"] == "ready"
        assert row["track_count"] == 1
        assert row["container_type"] == "zip"
        chapters = audiobook_db.get_audiobook_chapters(md5=_MD5)
        assert len(chapters) == 1
        # File landed at audiobooks/<md5>/
        assert (out_dir / "audiobooks" / _MD5 / "track.mp3").is_file()
        assert chapters[0]["rel_path"] == f"audiobooks/{_MD5}/track.mp3"
        assert not (out_dir / "audiobooks" / f"{_MD5}.tmp").exists()

    def test_should_order_multi_file_chapters_naturally(
        self, tmp_path: Path, db_redirect: str
    ) -> None:
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        mp3 = tmp_path / "src.mp3"
        _make_mp3(mp3)
        archive = out_dir / f"{_MD5}.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.write(mp3, "disc/chapter 2.mp3")
            zf.write(mp3, "disc/chapter 10.mp3")
            zf.write(mp3, "disc/chapter 34 first half.mp3")

        status = process_audiobook(_MD5, str(archive), str(out_dir))
        assert status == "ready"
        chapters = audiobook_db.get_audiobook_chapters(md5=_MD5)
        rels = [c["rel_path"] for c in chapters]
        assert rels == [
            f"audiobooks/{_MD5}/disc/chapter 2.mp3",
            f"audiobooks/{_MD5}/disc/chapter 10.mp3",
            f"audiobooks/{_MD5}/disc/chapter 34 first half.mp3",
        ]

    def test_should_reject_traversal_member_and_write_nothing_outside(
        self, tmp_path: Path, db_redirect: str
    ) -> None:
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        mp3 = tmp_path / "src.mp3"
        _make_mp3(mp3)
        archive = out_dir / f"{_MD5}.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.write(mp3, "good.mp3")
            zf.writestr("../evil.txt", b"pwned")

        status = process_audiobook(_MD5, str(archive), str(out_dir))
        assert status in {"error", "unsupported"}
        # Nothing escaped to the parent of out_dir.
        assert not (tmp_path / "evil.txt").exists()
        assert not (out_dir / "audiobooks" / _MD5).exists()
        assert not (out_dir / "audiobooks" / f"{_MD5}.tmp").exists()
        row = audiobook_db.get_audiobook(md5=_MD5)
        assert row is not None and row["status"] in {"error", "unsupported"}

    def test_should_reject_reserved_name_member(self, tmp_path: Path, db_redirect: str) -> None:
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        mp3 = tmp_path / "src.mp3"
        _make_mp3(mp3)
        archive = out_dir / f"{_MD5}.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.write(mp3, "good.mp3")
            zf.writestr("CON.mp3", b"reserved")

        status = process_audiobook(_MD5, str(archive), str(out_dir))
        assert status in {"error", "unsupported"}
        assert not (out_dir / "audiobooks" / _MD5).exists()

    def test_should_be_idempotent_on_reprocess(self, tmp_path: Path, db_redirect: str) -> None:
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        mp3 = tmp_path / "track.mp3"
        _make_mp3(mp3)
        archive = out_dir / f"{_MD5}.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.write(mp3, "track.mp3")

        first = process_audiobook(_MD5, str(archive), str(out_dir))
        second = process_audiobook(_MD5, str(archive), str(out_dir))
        assert first == "ready"
        assert second == "ready"
        chapters = audiobook_db.get_audiobook_chapters(md5=_MD5)
        assert len(chapters) == 1  # not duplicated
        assert (out_dir / "audiobooks" / _MD5 / "track.mp3").is_file()


# ---------------------------------------------------------------------------
# sweep
# ---------------------------------------------------------------------------
class TestSweepStaleTmp:
    def test_should_delete_stale_tmp_dirs(self, tmp_path: Path) -> None:
        root = tmp_path / "audiobooks"
        root.mkdir()
        (root / "abc.tmp").mkdir()
        (root / "def.tmp").mkdir()
        (root / "keep").mkdir()
        removed = sweep_stale_tmp(str(tmp_path))
        assert removed == 2
        assert (root / "keep").exists()
        assert not (root / "abc.tmp").exists()

    def test_should_return_zero_when_no_audiobooks_dir(self, tmp_path: Path) -> None:
        assert sweep_stale_tmp(str(tmp_path)) == 0
