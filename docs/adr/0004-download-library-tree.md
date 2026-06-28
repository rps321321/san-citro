# Downloads are filed into a categorized library tree

> **SUPERSEDED by [ADR-0006](0006-library-is-a-db-view-over-flat-storage.md).** The
> physical folder tree was replaced by flat readable storage + a DB-driven library view.
> Retained for the rationale on author/year organization and the always-year reasoning.

Completed downloads are organized under `<download dir>/San Citro/<Category>/
<Author>/<Year>/` instead of dumped flat in the download root. **Category** is
Books or Audiobooks (by extension); **Author** is the full sanitized author string
(`Unknown Author` fallback); **Year** is the release year (`Unknown Year` fallback).

To make this possible the search-result metadata (title, author, year, extension)
— which today is dropped after the click — is threaded through the whole download
chain (`startDownload` → IPC → `enqueue` → `run_download` → save path), since the
library path is computed from it. Enabling audiobooks also means the scraper stops
filtering out audio formats (m4b, m4a, mp3, aac, flac, ogg, opus).

## Considered options

- **Conditional year (flat until 2+ books, then split) — rejected.** Matches the
  original ask but requires *moving an already-downloaded file* when the second
  book arrives, which breaks its stored path (Show-in-folder/reader), needs reorg
  + locking, and surprises the user. **Always `Author/Year/`** reaches the same end
  state deterministically.
- **Migrating existing downloads — rejected.** The history DB stores no author/year,
  the one existing completed file saved to an ambiguous relative path (may be
  unfindable), so a general migration is high-effort for ~1 file. Structure applies
  to new downloads only.

## Consequences

- The download IPC/bridge chain gains metadata params; the path-computation helper
  is the single place the tree shape lives.
- Deep nesting risks Windows MAX_PATH (260) — long author/title segments are
  truncated to stay safe.
- Audiobook downloadability via Anna's Archive's slow-download path is unverified;
  verify a real audiobook md5 downloads before relying on the Audiobooks branch.
