"""Binary locator and thin subprocess primitives for 7z and ffprobe.

Provides find_7z() / find_ffprobe() and two thin run-wrappers:
  list_archive(path) -> list[str]   — member names from a 7z archive
  probe_media(path)  -> dict        — ffprobe JSON (format + chapters)

NO audiobook orchestration here; that is a later phase.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from typing import Any

# ---------------------------------------------------------------------------
# Env-var overrides (highest priority)
# ---------------------------------------------------------------------------
_ENV_7Z = "SAN_CITRO_7Z"
_ENV_FFPROBE = "SAN_CITRO_FFPROBE"

# ---------------------------------------------------------------------------
# Bundled-binary path (frozen PyInstaller bundle or dev project-relative)
# ---------------------------------------------------------------------------
_BIN_DIR_NAME = os.path.join("electron-app", "bin")


def _bundled_dir() -> str:
    """Return the directory that should contain bundled binaries."""
    if getattr(sys, "frozen", False):
        # PyInstaller sets sys._MEIPASS when frozen
        return getattr(sys, "_MEIPASS", "")
    # Dev: relative to this file's package root (src/../electron-app/bin)
    return os.path.join(os.path.dirname(__file__), "..", _BIN_DIR_NAME)


# ---------------------------------------------------------------------------
# Locators
# ---------------------------------------------------------------------------


def find_7z() -> str:
    """Return the path to a usable 7z/7za binary.

    Search order:
    1. SAN_CITRO_7Z env override
    2. Bundled binary in electron-app/bin (or _MEIPASS when frozen)
    3. shutil.which("7z") then shutil.which("7za")
    4. Known Windows install paths
    """
    # 1. Env override
    env_path = os.environ.get(_ENV_7Z, "")
    if env_path and os.path.isfile(env_path):
        return env_path

    # 2. Bundled
    bin_dir = _bundled_dir()
    for name in ("7z.exe", "7z", "7za.exe", "7za"):
        candidate = os.path.join(bin_dir, name)
        if os.path.isfile(candidate):
            return candidate

    # 3. PATH
    for name in ("7z", "7za"):
        found = shutil.which(name)
        if found:
            return found

    # 4. Known install paths (Windows)
    known = [
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files\7-Zip\7za.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe",
    ]
    for path in known:
        if os.path.isfile(path):
            return path

    raise FileNotFoundError(
        "7z/7za binary not found. " f"Set {_ENV_7Z} env var or install 7-Zip to C:\\Program Files\\7-Zip\\."
    )


def find_ffprobe() -> str:
    """Return the path to a usable ffprobe binary.

    Search order:
    1. SAN_CITRO_FFPROBE env override
    2. Bundled binary in electron-app/bin (or _MEIPASS when frozen)
    3. shutil.which("ffprobe")
    4. Known install paths
    """
    # 1. Env override
    env_path = os.environ.get(_ENV_FFPROBE, "")
    if env_path and os.path.isfile(env_path):
        return env_path

    # 2. Bundled
    bin_dir = _bundled_dir()
    for name in ("ffprobe.exe", "ffprobe"):
        candidate = os.path.join(bin_dir, name)
        if os.path.isfile(candidate):
            return candidate

    # 3. PATH
    found = shutil.which("ffprobe")
    if found:
        return found

    # 4. Known install paths (Windows)
    known = [
        r"C:\Program Files\ffmpeg\bin\ffprobe.exe",
        r"C:\ffmpeg\bin\ffprobe.exe",
    ]
    for path in known:
        if os.path.isfile(path):
            return path

    raise FileNotFoundError(
        "ffprobe binary not found. " f"Set {_ENV_FFPROBE} env var or install ffmpeg and add it to PATH."
    )


# ---------------------------------------------------------------------------
# Thin subprocess primitives
# ---------------------------------------------------------------------------

_SUBPROCESS_TIMEOUT = 60  # seconds


def list_archive(path: str) -> list[str]:
    """Return the list of member filenames inside a 7z-supported archive.

    Runs ``7z l -slt <path>`` and parses ``Path = ...`` lines from the
    verbose listing.  Falls back to plain ``7z l`` output if the -slt flag
    is unsupported by an older build.
    """
    binary = find_7z()
    result = subprocess.run(
        [binary, "l", "-slt", path],
        capture_output=True,
        text=True,
        timeout=_SUBPROCESS_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"7z list failed (exit {result.returncode}): {result.stderr.strip()}")

    members: list[str] = []
    for line in result.stdout.splitlines():
        if line.startswith("Path = "):
            name = line[len("Path = ") :].strip()
            # -slt output starts with a header "Path = <archive itself>" before
            # listing entries; skip lines that equal the archive path itself.
            if name and name != path:
                members.append(name)
    return members


def probe_media(path: str) -> dict[str, Any]:
    """Return ffprobe JSON for a media file (format + chapters).

    Runs ``ffprobe -v quiet -print_format json -show_format -show_chapters``
    and returns the parsed dict.
    """
    binary = find_ffprobe()
    result = subprocess.run(
        [binary, "-v", "quiet", "-print_format", "json", "-show_format", "-show_chapters", path],
        capture_output=True,
        text=True,
        timeout=_SUBPROCESS_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed (exit {result.returncode}): {result.stderr.strip()}")
    return json.loads(result.stdout)  # type: ignore[no-any-return]
