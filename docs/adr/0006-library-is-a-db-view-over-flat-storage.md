# The library is a DB-driven view over flat, readable, md5-identified storage

**Supersedes ADR-0004 and ADR-0005.**

Downloads are stored as **human-readable files, flat** under `<download dir>/San Citro/`
— single books directly (`Title - Author.ext`), audiobooks under `San Citro/audiobooks/
<md5>/<readable tracks>` (an md5 folder groups a multi-file audiobook). Every download is
identified by **md5** and indexed in **SQLite** with rich metadata (author, year, category,
language, cover_url, …). Organization by author / year / category is a **DB-driven view in
the in-app Library**, NOT a physical folder hierarchy.

## Why the reversal

The physical tree (ADR-0004/0005) coupled the on-disk path to metadata *quality*: missing
author/year forced `Unknown Author`/`Unknown Year` folders, deep nesting risked Windows
MAX_PATH, (re)classification required **moving already-downloaded files** (breaking their
stored path, Show-in-folder, and the reader), and a download-as-folder broke the flat
filename resolver. The review of the audiobook plan surfaced all of this.

The DB-view model **decouples organization from storage**: files never move, metadata can be
corrected or re-grouped freely (it's a query, not a `mv`), the disk stays human-readable
(just flat), and the in-app Library can group/sort/filter any way without touching disk.
This is the Calibre/iTunes model — the app is the organized access path; disk layout is an
implementation detail.

## Consequences

- The **metadata spine still required**: thread `author/year/extension/content_type` (and
  `cover_url`/`language`/`publisher` for a rich view) from search → download and persist to
  the `downloads` table. It now feeds the DB view instead of the path. This is the keystone
  fix and unblocks both books and audiobooks.
- Flat storage needs a **filename-collision policy** (two `Title - Author.ext` could clash).
- `resolve_download_path` / Show-in-folder resolve under `San Citro/` (not the download root).
- Audiobook physical storage (`San Citro/audiobooks/<md5>/`) from the audiobook plan is
  **retained** — it was only the *book* tree that changed.
