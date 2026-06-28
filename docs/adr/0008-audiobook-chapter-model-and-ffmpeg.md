# Audiobook chapter model (from real AA structures) + bundled FFmpeg for metadata/chapters

**Grounded by a live spike (2026-06-28):** downloaded three real AA audiobooks through the
app's existing Chrome path (30 MB in **17 s** — large-archive download is a non-issue) and
extracted them. The inner structures observed:

| Sample | Inner structure |
|---|---|
| Outer Banks — Lights Out | 1 × `.mp3`, flat (a single-file audiobook) |
| The Tales of Beedle the Bard | 1 × `.m4b` + 1 × `.jpg` cover (m4b **does** occur; has internal chapters) |
| Elementary Chinese Reader 2 | 23 × `.mp3` in a subfolder, `chapter 23.mp3 … chapter 34 first half.mp3` |

So all three forms exist: single-mp3, single-m4b, and multi-file-mp3-collection (nested,
non-uniform names). Archives also carry embedded cover images.

## Decisions

- **Chapter model:** extract (7-Zip) → recurse for audio files → for a *collection*, one
  chapter per file ordered by **natural-sort filename** (`chapter 23` < `chapter 34 first
  half`); for a *single mp3*, one chapter; for a *single m4b*, its **internal chapters**.
- **Media tooling = bundled full FFmpeg.** `ffprobe -show_chapters -show_format` yields m4b
  chapters (start/end/title), durations for *all* audio, and real-audio validation — one
  battle-tested binary that **replaces both the hand-rolled MP4 box-parser (the plan's
  highest-risk module) and mutagen**. `ffmpeg` itself is bundled for future transcoding
  (deferred — all common formats play on Electron's proprietary-codec FFmpeg).
- **Covers:** prefer the embedded `.jpg` inside the archive over the (expiring) AA URL.
- **Codec:** Electron's prebuilt ships FFmpeg *with* proprietary codecs, so `.m4b`/AAC plays;
  confirm with a 30-second in-app check (low risk, not a blocker).

## Consequences

- The frozen bundle now ships **two extra binaries** (7-Zip + FFmpeg, ~+70–100 MB);
  PyInstaller/electron-builder must include both per-platform and verify they run in the
  packaged app.
- Chapters are derived post-extraction by shelling out to ffprobe; the renderer never parses
  media bytes.
- Transcoding is a present-but-unused capability (v1 plays natively); revisit only if a real
  file fails to play.
