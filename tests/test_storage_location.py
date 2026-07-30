"""Storage location seam tests (ADR-0006).

Covers San Citro book path build, audiobook md5 grouping, deterministic
collision suffixes, and resolve preference (new layout first, then legacy).
Observable path behavior only — no private helpers.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src import storage_location as sl


@pytest.fixture()
def out_dir(tmp_path: Path) -> str:
    d = tmp_path / "downloads"
    d.mkdir()
    return str(d)


class TestBookWritePath:
    def test_book_download_dir_is_under_san_citro(self, out_dir: str) -> None:
        write_dir = sl.book_download_dir(out_dir)
        assert Path(write_dir).name == "San Citro"
        assert Path(write_dir).parent == Path(out_dir)
        assert Path(write_dir).is_dir()

    def test_book_path_joins_readable_filename(self, out_dir: str) -> None:
        path = sl.book_path(out_dir, "The Great Gatsby - F Scott Fitzgerald.epub")
        assert Path(path) == Path(out_dir) / "San Citro" / "The Great Gatsby - F Scott Fitzgerald.epub"

    def test_book_path_strips_directory_components_from_filename(self, out_dir: str) -> None:
        path = sl.book_path(out_dir, r"..\evil\Title.epub")
        assert Path(path).parent == Path(out_dir) / "San Citro"
        assert Path(path).name == "Title.epub"


class TestAudiobookPaths:
    def test_audiobook_dir_groups_under_san_citro_md5(self, out_dir: str) -> None:
        md5 = "a" * 32
        path = sl.audiobook_dir(out_dir, md5)
        assert Path(path) == Path(out_dir) / "San Citro" / "audiobooks" / md5

    def test_audiobook_folder_rel_is_posix_under_san_citro(self) -> None:
        md5 = "b" * 32
        assert sl.audiobook_folder_rel(md5) == f"San Citro/audiobooks/{md5}"


class TestCollisionPolicy:
    def test_unique_path_returns_original_when_absent(self, tmp_path: Path) -> None:
        target = tmp_path / "Book - Author.epub"
        assert sl.unique_path(str(target)) == str(target)

    def test_unique_path_adds_deterministic_suffix_when_present(self, tmp_path: Path) -> None:
        existing = tmp_path / "Book - Author.epub"
        existing.write_bytes(b"one")
        first = sl.unique_path(str(existing))
        assert first == str(tmp_path / "Book - Author (1).epub")
        Path(first).write_bytes(b"two")
        second = sl.unique_path(str(existing))
        assert second == str(tmp_path / "Book - Author (2).epub")

    def test_unique_path_never_returns_an_existing_path(self, tmp_path: Path) -> None:
        base = tmp_path / "Title.epub"
        base.write_bytes(b"0")
        (tmp_path / "Title (1).epub").write_bytes(b"1")
        (tmp_path / "Title (2).epub").write_bytes(b"2")
        got = sl.unique_path(str(base))
        assert got == str(tmp_path / "Title (3).epub")
        assert not Path(got).exists()


class TestResolvePreference:
    def test_resolve_prefers_san_citro_book_over_legacy_flat(self, out_dir: str) -> None:
        name = "Shared Title - Author.epub"
        legacy = Path(out_dir) / name
        modern = Path(out_dir) / "San Citro" / name
        legacy.write_bytes(b"legacy")
        modern.parent.mkdir(parents=True)
        modern.write_bytes(b"modern")

        resolved = sl.resolve_download_path(out_dir, filename=name, md5="c" * 32)
        assert resolved is not None
        assert Path(resolved).resolve() == modern.resolve()

    def test_resolve_falls_back_to_legacy_flat_book(self, out_dir: str) -> None:
        name = "Legacy Only - Author.pdf"
        legacy = Path(out_dir) / name
        legacy.write_bytes(b"old")

        resolved = sl.resolve_download_path(out_dir, filename=name, md5="d" * 32)
        assert resolved is not None
        assert Path(resolved).resolve() == legacy.resolve()

    def test_resolve_prefers_san_citro_audiobook_dir(self, out_dir: str) -> None:
        md5 = "e" * 32
        name = "pack.zip"
        legacy_ab = Path(out_dir) / "audiobooks" / md5
        modern_ab = Path(out_dir) / "San Citro" / "audiobooks" / md5
        legacy_ab.mkdir(parents=True)
        modern_ab.mkdir(parents=True)
        (legacy_ab / "track.mp3").write_bytes(b"L")
        (modern_ab / "track.mp3").write_bytes(b"M")

        resolved = sl.resolve_download_path(out_dir, filename=name, md5=md5)
        assert resolved is not None
        assert Path(resolved).resolve() == modern_ab.resolve()

    def test_resolve_falls_back_to_legacy_audiobook_dir(self, out_dir: str) -> None:
        md5 = "f" * 32
        legacy_ab = Path(out_dir) / "audiobooks" / md5
        legacy_ab.mkdir(parents=True)
        (legacy_ab / "track.mp3").write_bytes(b"L")

        resolved = sl.resolve_download_path(out_dir, filename="gone.zip", md5=md5)
        assert resolved is not None
        assert Path(resolved).resolve() == legacy_ab.resolve()

    def test_resolve_returns_none_when_nothing_exists(self, out_dir: str) -> None:
        assert sl.resolve_download_path(out_dir, filename="missing.epub", md5="0" * 32) is None

    def test_resolve_rejects_path_escape_via_filename(self, out_dir: str, tmp_path: Path) -> None:
        outside = tmp_path / "outside.epub"
        outside.write_bytes(b"secret")
        # basename-only policy: ".." components must not escape out_dir
        resolved = sl.resolve_download_path(out_dir, filename="../outside.epub", md5="1" * 32)
        assert resolved is None or not Path(resolved).resolve().samefile(outside)

    def test_resolve_book_file_only_ignores_audiobook_dirs(self, out_dir: str) -> None:
        md5 = "2" * 32
        ab = Path(out_dir) / "San Citro" / "audiobooks" / md5
        ab.mkdir(parents=True)
        (ab / "t.mp3").write_bytes(b"x")
        assert sl.resolve_book_file(out_dir, "missing.zip") is None
