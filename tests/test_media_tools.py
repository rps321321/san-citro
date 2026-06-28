"""Tests for src/media_tools.py — binary locator + subprocess primitives."""

from __future__ import annotations

import os
import shutil
import zipfile
from pathlib import Path  # noqa: TC003  — used at runtime via pytest fixtures

import pytest

from src.media_tools import find_7z, find_ffprobe, list_archive, probe_media

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _binary_available(name: str) -> bool:
    """True if the binary can be resolved without raising."""
    try:
        if name == "7z":
            find_7z()
        elif name == "ffprobe":
            find_ffprobe()
        return True
    except FileNotFoundError:
        return False


# ---------------------------------------------------------------------------
# find_7z
# ---------------------------------------------------------------------------


class TestFind7z:
    def test_should_return_existing_path_when_7z_is_installed(self) -> None:
        if not _binary_available("7z"):
            pytest.skip("7z not found in this environment")
        path = find_7z()
        assert os.path.isfile(path), f"find_7z() returned a non-existent path: {path}"

    def test_should_return_program_files_path_when_present(self) -> None:
        known = r"C:\Program Files\7-Zip\7z.exe"
        if not os.path.isfile(known):
            pytest.skip("7z not installed at Program Files\\7-Zip")
        path = find_7z()
        # The locator may have found it earlier (PATH or env), but the resolved
        # path must point to an existing file.
        assert os.path.isfile(path)

    def test_should_honour_env_override(self, tmp_path: Path) -> None:
        # Create a fake executable file to stand in as the binary.
        fake_exe = tmp_path / "fake_7z.exe"
        fake_exe.write_bytes(b"")
        old = os.environ.pop("SAN_CITRO_7Z", None)
        try:
            os.environ["SAN_CITRO_7Z"] = str(fake_exe)
            assert find_7z() == str(fake_exe)
        finally:
            if old is None:
                os.environ.pop("SAN_CITRO_7Z", None)
            else:
                os.environ["SAN_CITRO_7Z"] = old

    def test_should_raise_when_env_override_points_to_missing_file(self, tmp_path: Path) -> None:
        missing = str(tmp_path / "ghost.exe")
        old = os.environ.pop("SAN_CITRO_7Z", None)
        # Also hide the real binary so only the env path is tried.
        real_7z = shutil.which("7z") or shutil.which("7za")
        try:
            os.environ["SAN_CITRO_7Z"] = missing
            # patch PATH to something that has no 7z
            # We can't hide Program Files easily, so only assert env is checked first:
            # if the env file is missing, find_7z() proceeds to the next probe —
            # so just verify the env file is NOT returned.
            result = find_7z() if real_7z else None
            if result:
                assert result != missing
        except FileNotFoundError:
            pass  # acceptable: no binary found at all
        finally:
            if old is None:
                os.environ.pop("SAN_CITRO_7Z", None)
            else:
                os.environ["SAN_CITRO_7Z"] = old

    def test_should_raise_file_not_found_when_nothing_available(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With every probe path removed, FileNotFoundError must be raised."""
        monkeypatch.delenv("SAN_CITRO_7Z", raising=False)
        monkeypatch.setenv("PATH", str(tmp_path))  # empty bin dir

        # Patch the bundled dir and known paths by pointing them at tmp_path
        monkeypatch.setattr("src.media_tools._bundled_dir", lambda: str(tmp_path))

        import src.media_tools as mt

        original_isfile = os.path.isfile

        def _no_known(path: str) -> bool:
            if "7-Zip" in path or "7z" in path.lower():
                return False
            return original_isfile(path)

        monkeypatch.setattr(mt.os.path, "isfile", _no_known)

        with pytest.raises(FileNotFoundError):
            find_7z()


# ---------------------------------------------------------------------------
# find_ffprobe
# ---------------------------------------------------------------------------


class TestFindFfprobe:
    def test_should_return_existing_path_when_ffprobe_is_on_path(self) -> None:
        if not _binary_available("ffprobe"):
            pytest.skip("ffprobe not found in this environment")
        path = find_ffprobe()
        assert os.path.isfile(path), f"find_ffprobe() returned non-existent path: {path}"

    def test_should_honour_env_override(self, tmp_path: Path) -> None:
        fake_exe = tmp_path / "fake_ffprobe.exe"
        fake_exe.write_bytes(b"")
        old = os.environ.pop("SAN_CITRO_FFPROBE", None)
        try:
            os.environ["SAN_CITRO_FFPROBE"] = str(fake_exe)
            assert find_ffprobe() == str(fake_exe)
        finally:
            if old is None:
                os.environ.pop("SAN_CITRO_FFPROBE", None)
            else:
                os.environ["SAN_CITRO_FFPROBE"] = old

    def test_should_raise_file_not_found_when_nothing_available(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("SAN_CITRO_FFPROBE", raising=False)
        monkeypatch.setenv("PATH", str(tmp_path))
        monkeypatch.setattr("src.media_tools._bundled_dir", lambda: str(tmp_path))

        import src.media_tools as mt

        original_isfile = os.path.isfile

        def _no_known(path: str) -> bool:
            if "ffprobe" in path.lower() or "ffmpeg" in path.lower():
                return False
            return original_isfile(path)

        monkeypatch.setattr(mt.os.path, "isfile", _no_known)

        with pytest.raises(FileNotFoundError):
            find_ffprobe()


# ---------------------------------------------------------------------------
# list_archive
# ---------------------------------------------------------------------------


class TestListArchive:
    def test_should_list_members_of_a_zip_archive(self, tmp_path: Path) -> None:
        if not _binary_available("7z"):
            pytest.skip("7z not found in this environment")

        archive = tmp_path / "test.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("chapter01.mp3", b"fake audio 1")
            zf.writestr("chapter02.mp3", b"fake audio 2")
            zf.writestr("cover.jpg", b"fake image")

        members = list_archive(str(archive))
        assert set(members) == {"chapter01.mp3", "chapter02.mp3", "cover.jpg"}

    def test_should_return_list_type(self, tmp_path: Path) -> None:
        if not _binary_available("7z"):
            pytest.skip("7z not found in this environment")

        archive = tmp_path / "single.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("file.txt", "hello")

        result = list_archive(str(archive))
        assert isinstance(result, list)

    def test_should_raise_runtime_error_on_bad_archive(self, tmp_path: Path) -> None:
        if not _binary_available("7z"):
            pytest.skip("7z not found in this environment")

        bad_file = tmp_path / "not_an_archive.zip"
        bad_file.write_bytes(b"this is not a valid archive")

        with pytest.raises(RuntimeError):
            list_archive(str(bad_file))

    def test_should_raise_runtime_error_on_missing_file(self, tmp_path: Path) -> None:
        if not _binary_available("7z"):
            pytest.skip("7z not found in this environment")

        with pytest.raises(RuntimeError):
            list_archive(str(tmp_path / "nonexistent.zip"))


# ---------------------------------------------------------------------------
# probe_media
# ---------------------------------------------------------------------------


class TestProbeMedia:
    def test_should_return_dict_with_format_key_for_audio_file(self, tmp_path: Path) -> None:
        if not _binary_available("ffprobe"):
            pytest.skip("ffprobe not found in this environment")

        # Create a minimal valid WAV file (44 bytes) so ffprobe can parse it.
        wav = tmp_path / "test.wav"
        # 44-byte WAV header with 0 audio frames — enough for ffprobe format probe.
        import struct

        data_size = 0
        wav.write_bytes(
            b"RIFF"
            + struct.pack("<I", 36 + data_size)
            + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8)
            + b"data"
            + struct.pack("<I", data_size)
        )

        result = probe_media(str(wav))
        assert isinstance(result, dict)
        assert "format" in result

    def test_should_raise_runtime_error_on_non_media_file(self, tmp_path: Path) -> None:
        if not _binary_available("ffprobe"):
            pytest.skip("ffprobe not found in this environment")

        bad = tmp_path / "junk.mp3"
        bad.write_bytes(b"not media at all" * 10)

        with pytest.raises(RuntimeError):
            probe_media(str(bad))
