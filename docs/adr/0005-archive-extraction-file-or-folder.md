# An archive download is extracted into a folder; a download is a file or a folder

> **SUPERSEDED by [ADR-0006](0006-library-is-a-db-view-over-flat-storage.md)** for the
> *location* (extraction now targets `San Citro/audiobooks/<md5>/`, not a category tree).
> The file-or-folder artifact model and the extract-then-classify-by-contents reasoning
> still hold.

Archive downloads (zip/rar — chiefly audiobook bundles) are **extracted** into a
folder in the library, **classified by their contents** (dominant audio → Audiobooks,
else Books), and the original archive is **deleted after the extraction verifies**.
Non-archive downloads stay single files, classified by their own extension.

This makes a completed download either a single file or a folder. Everything that
assumed "one download = one file" must handle the folder case: the history record
stores the artifact's path (file or folder), Show-in-folder reveals it, the in-app
reader applies only to single epub files (an extracted/audiobook folder isn't
readable), and resume/cleanup distinguish the transient archive from the final folder.

## Considered options

- **Peek the archive index, keep the file — rejected by the user** in favor of full
  extraction (nicer for multi-file audiobooks) despite the broader model change.
- **Extension-only, no inspection — rejected**: a zip of mp3s would misfile as Books.

## Consequences

- Extraction briefly doubles disk use; failures (corrupt/partial/password-protected
  archives) must leave the download in a clean `failed` state, not a half-folder.
- Classification needs the archive contents, so it happens *after* download — the
  category isn't known until extraction completes.
