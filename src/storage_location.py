"""Storage location policy for San Citro downloads (ADR-0006).

Owns where Artifacts land on disk and how Show-in-folder / reader / media
resolve them:

- Books: flat human-readable files under ``<out_dir>/San Citro/``
  (``Title - Author.ext``).
- Audiobooks: multi-file packs under ``<out_dir>/San Citro/audiobooks/<md5>/``.
- Collision: deterministic `` (N)`` suffix before the extension — never silent
  overwrite.
- Resolve: prefer the San Citro layout, then legacy flat ``out_dir`` /
  legacy ``out_dir/audiobooks/<md5>``. No forced mass-move on upgrade.

The Library remains a DB-driven view; this module only decides physical paths.
"""

from __future__ import annotations

import os

# Directory name under the configured download root (out_dir).
SAN_CITRO_DIR = "San Citro"
AUDIOBOOKS_SUBDIR = "audiobooks"


def san_citro_root(out_dir: str) -> str:
    """Return ``<out_dir>/San Citro`` (not created)."""
    return os.path.join(out_dir, SAN_CITRO_DIR)


def book_download_dir(out_dir: str) -> str:
    """Directory where new book Artifacts are written. Creates San Citro if needed."""
    root = san_citro_root(out_dir)
    os.makedirs(root, exist_ok=True)
    return root


def book_path(out_dir: str, filename: str) -> str:
    """Absolute path for a book file under San Citro (basename only; no create)."""
    safe = os.path.basename(filename.replace("\\", "/"))
    return os.path.join(san_citro_root(out_dir), safe)


def audiobooks_root(out_dir: str) -> str:
    """``<out_dir>/San Citro/audiobooks`` — parent of per-md5 packs (not created)."""
    return os.path.join(san_citro_root(out_dir), AUDIOBOOKS_SUBDIR)


def audiobook_dir(out_dir: str, md5: str) -> str:
    """Absolute path for an audiobook pack directory (new layout)."""
    return os.path.join(audiobooks_root(out_dir), md5)


def legacy_audiobook_dir(out_dir: str, md5: str) -> str:
    """Pre-San-Citro audiobook pack path: ``<out_dir>/audiobooks/<md5>``."""
    return os.path.join(out_dir, AUDIOBOOKS_SUBDIR, md5)


def audiobook_folder_rel(md5: str) -> str:
    """Posix-relative folder path stored on ``audiobooks.folder_path`` (new layout)."""
    return f"{SAN_CITRO_DIR}/{AUDIOBOOKS_SUBDIR}/{md5}"


def unique_path(path: str) -> str:
    """Return *path* if free; else ``stem (1).ext``, ``stem (2).ext``, … until free.

    Deterministic collision policy: never silently overwrite an existing file
    or directory at the desired path.
    """
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    counter = 1
    while True:
        candidate = f"{base} ({counter}){ext}"
        if not os.path.exists(candidate):
            return candidate
        counter += 1


def _realpath_contained(candidate: str, out_dir_real: str) -> str | None:
    """Return realpath of *candidate* if it exists and lives under *out_dir_real*."""
    if not candidate:
        return None
    try:
        real = os.path.realpath(candidate)
    except OSError:
        return None
    if real == out_dir_real or real.startswith(out_dir_real + os.sep):
        if os.path.exists(real):
            return real
    return None


def resolve_book_file(out_dir: str, filename: str | None) -> str | None:
    """Resolve a book/archive file path: San Citro first, then legacy flat out_dir.

    *filename* is treated as a basename (path components stripped). Returns a
    realpath contained under *out_dir*, or None.
    """
    if not filename:
        return None
    safe = os.path.basename(str(filename).replace("\\", "/"))
    if not safe or safe in (".", ".."):
        return None
    try:
        out_real = os.path.realpath(out_dir)
    except OSError:
        return None

    # Prefer new layout; fall back to legacy flat layout.
    for candidate in (
        os.path.join(san_citro_root(out_dir), safe),
        os.path.join(out_dir, safe),
    ):
        found = _realpath_contained(candidate, out_real)
        if found is not None and os.path.isfile(found):
            return found
    return None


def resolve_audiobook_dir(out_dir: str, md5: str | None) -> str | None:
    """Resolve an audiobook pack directory: San Citro first, then legacy.

    Returns a realpath directory contained under *out_dir*, or None.
    """
    if not md5:
        return None
    try:
        out_real = os.path.realpath(out_dir)
    except OSError:
        return None
    for candidate in (
        audiobook_dir(out_dir, md5),
        legacy_audiobook_dir(out_dir, md5),
    ):
        found = _realpath_contained(candidate, out_real)
        if found is not None and os.path.isdir(found):
            return found
    return None


def resolve_download_path(
    out_dir: str,
    *,
    filename: str | None = None,
    md5: str | None = None,
) -> str | None:
    """Resolve an Artifact for Show-in-folder / reader / media.

    Preference order:
    1. San Citro book file (``San Citro/<filename>``)
    2. Legacy flat book file (``<out_dir>/<filename>``)
    3. San Citro audiobook dir (``San Citro/audiobooks/<md5>``)
    4. Legacy audiobook dir (``audiobooks/<md5>``)

    Returns a realpath contained under *out_dir*, or None. Does not move files.
    """
    book = resolve_book_file(out_dir, filename)
    if book is not None:
        return book
    return resolve_audiobook_dir(out_dir, md5)
