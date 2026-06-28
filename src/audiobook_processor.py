"""Authoritative audiobook classification + hardened archive processing.

This is the SECURITY-CRITICAL module: it extracts UNTRUSTED archives downloaded
from the internet. It classifies a downloaded file, safely extracts it (7-Zip,
all formats), scans for audio, builds an ordered chapter list (multi-file or
single-``.m4b`` internal chapters via ffprobe), and persists to
:mod:`audiobook_db` — atomically, idempotently, and never raising to the caller.

The defense is layered: pre-flight caps reject obviously-hostile listings before
a byte is written, but the declared sizes/paths in an archive are
attacker-controlled, so the REAL guard is post-extraction validation that walks
the on-disk tree, rejects symlinks/reparse points, and realpath-contains every
entry under the temp dir (zip-slip).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Any

from . import audiobook_db, media_tools
from .logger import get_logger

logger = get_logger()

# ---------------------------------------------------------------------------
# Extension sets
# ---------------------------------------------------------------------------
_AUDIO_EXTENSIONS = frozenset({"mp3", "m4b", "m4a", "aac", "flac", "ogg", "opus", "wav"})
_ARCHIVE_EXTENSIONS = frozenset({"zip", "rar", "7z"})

# ---------------------------------------------------------------------------
# Pre-flight caps (cheap, declared-size based; the real guard is post-extract)
# ---------------------------------------------------------------------------
_MAX_MEMBERS = 2000
_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024  # 10 GB
_MAX_SINGLE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB

_EXTRACT_TIMEOUT = 600  # seconds

# Windows reserved device names (case-insensitive, with or without extension).
_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(0, 10)} | {f"LPT{i}" for i in range(0, 10)}
)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _ext(path: str) -> str:
    """Lowercase extension without the leading dot ('' if none)."""
    return os.path.splitext(path)[1].lstrip(".").lower()


def _is_archive(path: str) -> bool:
    return _ext(path) in _ARCHIVE_EXTENSIONS


def _is_audio(path: str) -> bool:
    return _ext(path) in _AUDIO_EXTENSIONS


def _is_reserved_name(name: str) -> bool:
    """True if a single path component is a Windows reserved device name.

    Matches CON, PRN, COM3, etc. — INCLUDING with an extension (``CON.mp3``),
    a trailing dot/space (``CON. ``/``CON ``), and any case.
    """
    component = name.strip().rstrip(". ")
    stem = component.split(".", 1)[0].strip().upper()
    return stem in _RESERVED_NAMES


def _natural_key(text: str) -> list[Any]:
    """Natural-sort key: split digit runs so 'chapter 2' < 'chapter 10'.

    Digit runs become ints; everything else is lowercased text. This makes
    "chapter 34 first half" sort after "chapter 10" but on the same axis as
    "chapter 34".
    """
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


# ---------------------------------------------------------------------------
# Classification (authoritative — ignores any search hint)
# ---------------------------------------------------------------------------
def classify(path: str) -> str:
    """Return "audiobook", "book", or "other" for a downloaded file.

    Authoritative: inspects the real file/archive, never trusts a search hint.
    - An archive whose members include any audio file -> "audiobook"; else "book".
    - A single audio file by extension -> "audiobook".
    - Anything else -> "book".
    """
    if _is_archive(path):
        try:
            members = media_tools.list_archive(path)
        except (RuntimeError, FileNotFoundError, subprocess.SubprocessError) as exc:
            logger.warning("classify: could not list %s: %s", path, exc)
            return "book"
        return "audiobook" if any(_is_audio(m) for m in members) else "book"
    if _is_audio(path):
        return "audiobook"
    return "book"


# ---------------------------------------------------------------------------
# Pre-flight: list-with-sizes via `7z l -slt`
# ---------------------------------------------------------------------------
def _list_with_sizes(archive: str) -> list[tuple[str, int]]:
    """Return [(member_path, declared_size_bytes), ...] via ``7z l -slt``.

    The verbose ``-slt`` listing emits a ``Path = ...`` then a ``Size = ...``
    line per entry. Directory entries (no Size) are skipped. The leading header
    block (whose Path equals the archive itself) is skipped too.
    """
    binary = media_tools.find_7z()
    result = subprocess.run(
        [binary, "l", "-slt", archive],
        capture_output=True,
        text=True,
        timeout=_EXTRACT_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"7z list failed (exit {result.returncode}): {result.stderr.strip()}")

    entries: list[tuple[str, int]] = []
    current_path: str | None = None
    for line in result.stdout.splitlines():
        if line.startswith("Path = "):
            current_path = line[len("Path = ") :].strip()
        elif line.startswith("Size = ") and current_path is not None:
            if current_path == archive:
                current_path = None
                continue
            raw = line[len("Size = ") :].strip()
            try:
                size = int(raw)
            except ValueError:
                size = 0
            entries.append((current_path, size))
            current_path = None
    return entries


def _member_is_unsafe(member: str) -> bool:
    """True if an archive member name is hostile / not safe to extract.

    Rejects: absolute paths, drive-relative (``C:x``), UNC / leading separator,
    ``..`` as a path component (after normalizing both separators), Windows
    reserved device names per component, and nested archives. A plain
    ``subdir/file`` (or ``subdir\\file`` — 7-Zip emits backslashes on Windows)
    is allowed; the post-extraction realpath containment is the real guard.
    """
    if not member:
        return True
    # Drive-relative or absolute drive path: "C:x", "C:\x".
    if re.match(r"^[A-Za-z]:", member):
        return True
    # Leading separator: POSIX-absolute "/x" or UNC/"\x".
    if member.startswith(("/", "\\")):
        return True
    # Normalize BOTH separators to '/' before splitting into components.
    parts = member.replace("\\", "/").split("/")
    if ".." in parts:
        return True
    if any(_is_reserved_name(part) for part in parts if part):
        return True
    # Nested archive members are refused outright.
    return _is_archive(member)


def _preflight(archive: str) -> str | None:
    """Validate the archive listing. Return None if OK, else a rejection reason."""
    entries = _list_with_sizes(archive)
    if len(entries) > _MAX_MEMBERS:
        return f"too many members ({len(entries)} > {_MAX_MEMBERS})"
    total = 0
    for member, size in entries:
        if size > _MAX_SINGLE_BYTES:
            return f"member too large ({member}: {size} bytes)"
        total += size
        if _member_is_unsafe(member):
            return f"unsafe member path: {member!r}"
    if total > _MAX_TOTAL_BYTES:
        return f"declared total too large ({total} bytes)"
    return None


# ---------------------------------------------------------------------------
# Extraction + post-extraction validation (the real defense)
# ---------------------------------------------------------------------------
def _extract(archive: str, tmp: str) -> None:
    """Run ``7z x`` into *tmp* with no shell. Raises on failure/timeout."""
    binary = media_tools.find_7z()
    result = subprocess.run(
        [binary, "x", archive, f"-o{tmp}", "-y", "-bb0"],
        capture_output=True,
        text=True,
        timeout=_EXTRACT_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"7z extract failed (exit {result.returncode}): {result.stderr.strip()}")


def _validate_extracted(tmp: str) -> str | None:
    """Walk the extracted tree; return None if safe, else a rejection reason.

    For EVERY entry: reject symlinks/reparse points and any path whose realpath
    escapes *tmp* (zip-slip). Sum actual on-disk bytes and reject > 10 GB.
    """
    tmp_real = os.path.realpath(tmp)
    prefix = tmp_real + os.sep
    total = 0
    for root, dirs, files in os.walk(tmp):
        for name in dirs + files:
            entry = os.path.join(root, name)
            if os.path.islink(entry):
                return f"symlink/reparse point in archive: {entry}"
            real = os.path.realpath(entry)
            if real != tmp_real and not real.startswith(prefix):
                return f"zip-slip escape: {entry} -> {real}"
        for name in files:
            entry = os.path.join(root, name)
            try:
                total += os.path.getsize(entry)
            except OSError:
                # A broken/already-rejected entry; treat as suspect.
                return f"could not stat extracted file: {entry}"
            if total > _MAX_TOTAL_BYTES:
                return f"on-disk total too large ({total} bytes)"
    return None


# ---------------------------------------------------------------------------
# Chapter building
# ---------------------------------------------------------------------------
def _format_duration(probe: dict[str, Any]) -> float:
    """Pull format.duration (seconds) from a probe dict, 0.0 if absent/bad."""
    try:
        return float(probe.get("format", {}).get("duration", 0.0))
    except (TypeError, ValueError):
        return 0.0


def _build_m4b_chapters(rel_path: str, probe: dict[str, Any]) -> list[dict[str, Any]]:
    """One chapter per ffprobe chapter for a single ``.m4b`` (or whole-file)."""
    chapters_raw = probe.get("chapters") or []
    if not chapters_raw:
        return [
            {
                "chapter_index": 0,
                "rel_path": rel_path,
                "title": None,
                "start_offset_seconds": 0.0,
                "duration_seconds": _format_duration(probe),
            }
        ]
    fmt_duration = _format_duration(probe)
    built: list[dict[str, Any]] = []
    for index, chapter in enumerate(chapters_raw):
        try:
            start = float(chapter.get("start_time", 0.0))
        except (TypeError, ValueError):
            start = 0.0
        if index + 1 < len(chapters_raw):
            try:
                next_start = float(chapters_raw[index + 1].get("start_time", start))
            except (TypeError, ValueError):
                next_start = start
        else:
            next_start = fmt_duration
        duration = max(0.0, next_start - start)
        title = (chapter.get("tags") or {}).get("title") or f"Chapter {index + 1}"
        built.append(
            {
                "chapter_index": index,
                "rel_path": rel_path,
                "title": title,
                "start_offset_seconds": start,
                "duration_seconds": duration,
            }
        )
    return built


def _build_multi_chapters(audio_files: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """One chapter per audio file. *audio_files* = [(abs_path, rel_path), ...]."""
    built: list[dict[str, Any]] = []
    for index, (abs_path, rel_path) in enumerate(audio_files):
        probe = media_tools.probe_media(abs_path)
        title = (probe.get("format", {}).get("tags") or {}).get("title")
        if not title:
            title = os.path.splitext(os.path.basename(rel_path))[0]
        built.append(
            {
                "chapter_index": index,
                "rel_path": rel_path,
                "title": title,
                "start_offset_seconds": 0.0,
                "duration_seconds": _format_duration(probe),
            }
        )
    return built


def _scan_audio_files(final_dir: str, out_dir: str) -> list[tuple[str, str]]:
    """Collect audio files under *final_dir*, naturally sorted by rel path.

    Returns [(abs_path, rel_path_to_out_dir), ...]. ``rel_path`` looks like
    ``audiobooks/<md5>/.../track01.mp3``.
    """
    found: list[tuple[str, str]] = []
    for root, _dirs, files in os.walk(final_dir):
        for name in files:
            if _is_audio(name):
                abs_path = os.path.join(root, name)
                rel = os.path.relpath(abs_path, out_dir).replace(os.sep, "/")
                found.append((abs_path, rel))
    found.sort(key=lambda pair: _natural_key(pair[1]))
    return found


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def _cleanup(*paths: str) -> None:
    """Best-effort recursive delete of temp/final dirs."""
    for path in paths:
        shutil.rmtree(path, ignore_errors=True)


def _fail(md5: str, out_dir: str, status: str, message: str, *cleanup_paths: str) -> str:
    """Record a terminal failure status, clean up, and return the status."""
    logger.warning("audiobook %s -> %s: %s", md5[:8], status, message)
    _cleanup(*cleanup_paths)
    audiobook_db.set_audiobook_status(md5=md5, status=status, error_message=message)
    return status


def process_audiobook(md5: str, file_path: str, out_dir: str) -> str:
    """Classify, extract, scan, and persist an audiobook. Returns the status.

    Idempotent and exception-safe: any failure sets the audiobook status to
    ``error`` or ``unsupported`` and returns it; this NEVER raises to the caller
    and NEVER touches the downloads table.
    """
    try:
        audiobooks_root = os.path.join(out_dir, "audiobooks")
        tmp = os.path.join(audiobooks_root, f"{md5}.tmp")
        final = os.path.join(audiobooks_root, md5)

        # Already processed. The source archive is deleted on success, so a stray
        # re-enqueue must NOT re-classify a now-missing file and flip ready -> error.
        existing = audiobook_db.get_audiobook(md5=md5)
        if existing and existing.get("status") == "ready" and os.path.isdir(final):
            return "ready"

        if classify(file_path) != "audiobook":
            return "skipped"

        os.makedirs(audiobooks_root, exist_ok=True)
        _cleanup(tmp)  # stale temp from a crashed prior run

        audiobook_db.record_audiobook(md5=md5, status="processing")

        container_type = _ext(file_path) if _is_archive(file_path) else "file"

        if _is_archive(file_path):
            reason = _preflight(file_path)
            if reason is not None:
                return _fail(md5, out_dir, "unsupported", reason, tmp)
            try:
                _extract(file_path, tmp)
            except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
                return _fail(md5, out_dir, "error", f"extraction failed: {exc}", tmp)
            reason = _validate_extracted(tmp)
            if reason is not None:
                return _fail(md5, out_dir, "error", reason, tmp)
        else:
            # Single audio file: copy it into the temp dir under its real name.
            os.makedirs(tmp, exist_ok=True)
            shutil.copy2(file_path, os.path.join(tmp, os.path.basename(file_path)))

        # Scan against the temp tree using a forward-looking rel path under final.
        audio_files = _scan_tmp_as_final(tmp, final, out_dir)
        if not audio_files:
            return _fail(md5, out_dir, "unsupported", "no audio files found", tmp)

        chapters = _build_chapters(audio_files)
        if not chapters:
            return _fail(md5, out_dir, "unsupported", "no playable chapters", tmp)

        total_duration = sum(float(ch.get("duration_seconds") or 0.0) for ch in chapters)
        track_count = len(chapters)

        # Atomic finalize: tmp -> final (rmtree final first; os.replace needs it empty on Win).
        try:
            if os.path.exists(final):
                shutil.rmtree(final)
            os.replace(tmp, final)
        except OSError as exc:
            return _fail(md5, out_dir, "error", f"finalize failed: {exc}", tmp, final)

        audiobook_db.record_audiobook(
            md5=md5,
            container_type=container_type,
            folder_path=f"audiobooks/{md5}",
            total_duration_seconds=total_duration,
            track_count=track_count,
            status="ready",
        )
        audiobook_db.replace_chapters(md5=md5, chapters=chapters)

        # The source archive is now redundant (content lives under the audiobook
        # folder). Best-effort delete; a failure must not undo the ready status.
        try:
            os.remove(file_path)
        except OSError as exc:
            logger.warning("audiobook %s: could not remove source archive: %s", md5[:8], exc)

        logger.info("audiobook %s ready (%d chapter(s))", md5[:8], track_count)
        return "ready"
    except Exception as exc:  # last-resort: must never raise to the caller
        logger.exception("audiobook %s processing crashed", md5[:8])
        try:
            audiobook_db.set_audiobook_status(md5=md5, status="error", error_message=str(exc))
        except Exception:  # DB write is best-effort during a crash
            logger.exception("audiobook %s: failed to record error status", md5[:8])
        return "error"


def _scan_tmp_as_final(tmp: str, final: str, out_dir: str) -> list[tuple[str, str]]:
    """Scan audio files in *tmp* but compute rel paths as if under *final*.

    We probe the files in place (in ``tmp``) but the persisted ``rel_path`` must
    point at the post-rename ``final`` location, so we translate the prefix.
    """
    raw = _scan_audio_files(tmp, out_dir)
    tmp_rel = os.path.relpath(tmp, out_dir).replace(os.sep, "/")
    final_rel = os.path.relpath(final, out_dir).replace(os.sep, "/")
    translated: list[tuple[str, str]] = []
    for abs_path, rel in raw:
        if rel.startswith(tmp_rel + "/"):
            rel = final_rel + rel[len(tmp_rel) :]
        translated.append((abs_path, rel))
    return translated


def _build_chapters(audio_files: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """Dispatch to the m4b-chapter or multi-file builder per the spec rules."""
    if len(audio_files) == 1:
        abs_path, rel_path = audio_files[0]
        probe = media_tools.probe_media(abs_path)
        if _ext(rel_path) == "m4b":
            return _build_m4b_chapters(rel_path, probe)
        return [
            {
                "chapter_index": 0,
                "rel_path": rel_path,
                "title": None,
                "start_offset_seconds": 0.0,
                "duration_seconds": _format_duration(probe),
            }
        ]
    return _build_multi_chapters(audio_files)


# ---------------------------------------------------------------------------
# Startup sweep
# ---------------------------------------------------------------------------
def sweep_stale_tmp(out_dir: str) -> int:
    """Delete leftover ``<out_dir>/audiobooks/*.tmp`` dirs. Returns the count.

    Pairs with :func:`audiobook_db.reset_stuck_audiobooks` for the startup sweep:
    this reclaims orphaned extraction temp dirs from a crashed prior session.
    """
    audiobooks_root = os.path.join(out_dir, "audiobooks")
    if not os.path.isdir(audiobooks_root):
        return 0
    removed = 0
    for name in os.listdir(audiobooks_root):
        if name.endswith(".tmp"):
            path = os.path.join(audiobooks_root, name)
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
    if removed:
        logger.info("Swept %d stale audiobook .tmp dir(s)", removed)
    return removed
