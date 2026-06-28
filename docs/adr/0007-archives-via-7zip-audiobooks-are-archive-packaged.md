# Audiobooks are archive-packaged; extract all formats via a bundled 7-Zip CLI

**Empirically established (2026-06-28, probing the `annas-archive.gl` index):** Anna's
Archive *does* serve audiobooks, but as **zip/rar/7z archives** (200–320 MB), not audio
files — which is why they never appear in the file-type facet as `mp3`/`m4b` and an earlier
read wrongly concluded "no audiobooks." The `nexusstc` source packages each as
`<Title> (Audiobook)/<md5>.{zip,rar}`; across audiobook queries the split was ~58 RAR / 32
ZIP / a few 7z.

Decisions:
- **Detection** is by the `(Audiobook)`/`AUDIOBOOK`/`unabridged` token in the title/path
  (the file extension is just `zip`/`rar`), as a *hint*; the **authoritative** classification
  is post-download — extract and find audio members inside. (Vindicates the plan's three-tier
  model; some hits are ebooks "with free audiobook" — content inspection is the truth.)
- **Extraction uses a bundled 7-Zip CLI** (`7za.exe` + platform equivalents), shelled out:
  `7z l` to list/peek-classify, `7z x` into a sandboxed temp, then validate + move. One tool
  covers zip/rar/7z/tar/gz/etc. **This reverses the plan's "RAR unsupported" and "stdlib
  zipfile only"** — RAR is the *majority* format, and there is no pure-Python RAR5 extractor
  (every option shells out to a binary anyway).

## Consequences

- The PyInstaller bundle must ship the 7-Zip binary (per platform); add to the spec + verify.
- Extraction of untrusted archives still needs full hardening (path containment, byte/count
  caps via `7z l`, no symlink/junction follow) — the tool changes, the threat model doesn't.
- The scraper change is to recognize **archive** extensions + the audiobook keyword (not to
  add audio extensions, which AA never serves).
- **Open gate:** the inner format (mp3 collection vs single `.m4b`) is unconfirmed; a real
  download+extract spike must resolve it before building the chapter model / player.
