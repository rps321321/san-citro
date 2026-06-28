# Audiobook support — a local media subsystem (detection, processing, library, player)

> Status: PROPOSAL under review (saved 2026-06-28). Not yet accepted for build.
>
> **REVISIONS from review + AA probing (2026-06-28), authoritative over the body below:**
> - Storage: NOT the ADR-0004/0005 physical tree. Per **ADR-0006**, downloads are flat +
>   readable under `San Citro/` with a **DB-driven Library view**; audiobooks at
>   `San Citro/audiobooks/<md5>/`. A **metadata spine** (thread + persist author/year/
>   extension/content_type/cover) is required and is the keystone.
> - AA audiobooks are **zip/rar/7z archives (200–320 MB)**, detected by the `(Audiobook)`
>   title/path keyword (NOT extension; AA serves no audio ext). See **ADR-0007**.
> - Extraction: **bundled 7-Zip CLI** for all formats — **RAR is now SUPPORTED** (it's the
>   majority format), reversing this body's "rar unsupported" + "stdlib zipfile only".
> - Plan body's main.ts/bridge line numbers are STALE (~10–23 lines); re-locate before use.
> - OPEN gate before build: a real download+extract spike to confirm large-archive download
>   works and the inner format (mp3 collection vs single `.m4b`).

## Context

San Citro (Anna's Archive toolkit; one Electron app, `web/` Next.js renderer over the `san-citro://` IPC protocol, Python backend) handles **books only**. Adding audiobooks is **not "books + audio"** — it introduces a local media‑management subsystem with its own security, indexing, classification, storage, codec, corruption, and resumable‑playback concerns. This plan treats it as such.

Gaps today: (1) `src/scraper.py:44` has no audio formats → audiobooks scrape with `extension=null`; (2) no player, no archive extraction, no grouping of per‑chapter files; (3) no library, no resume, no bookmarks (the epub reader doesn't even persist position — it only fires telemetry).

**Outcome:** detect audiobooks in search (badge + filter); after download, the **backend authoritatively** classifies the file, safely extracts archives, groups multi‑file audiobooks (and single `.m4b` chapter markers) into one book with an ordered chapter list; a **Library** menu with **Audiobooks / Books** tabs; an in‑app player that streams + seeks, **resumes across restarts**, and supports **bookmarks** — all persisted in **local SQLite**.

### Locked decisions (this revision)
Incorporating the design review. Accepted in full; key positions:
- **Classification is three‑tier:** search = *tentative hint*; download‑complete = *authoritative* (backend inspects the real file/archive); library = *persisted authoritative truth*. The renderer never decides processing.
- **Schema gets stable IDs** (`chapter_id`), **foreign keys + cascade**, `CHECK` on status, `error_message`, `updated_at`; progress/bookmarks key off `chapter_id`, never a positional index. Paths stored **relative to `out_dir`** (survive a moved download root).
- **Progress semantics are defined precisely** (below) — the source of truth is `(chapter_id, file_position_seconds)`.
- **Extraction is hardened** (zip‑bomb/slip/symlink/reserved‑name limits) and **atomic** (`<md5>.tmp/` → rename).
- **Media protocol = least privilege:** separate scheme, no CORS, no fetch, strict validation, Range‑defensive; CSP gets `media-src`.
- **`.m4b` chapters: parse Nero `chpl` AND QuickTime chapter tracks.** A marker‑less file legitimately becomes one chapter (this is correct, not a fallback‑cop‑out).
- **`.rar`: honestly unsupported** in v1 (no bundled `unrar`) — marked `unsupported` with a clear UI message + "Show in folder", never a silent `extract_pending`.

### Deliberate divergences from the review (with rationale)
- **Identity stays `md5`, not a new local UUID.** `md5` is already the universal app key (PK of `downloads`, used by `resolve_download_path`, search dedup, telemetry). A parallel UUID adds joins everywhere for no v1 benefit. The review's real concern — *positional* `track_index` corrupting bookmarks/progress — is fixed by the stable `chapter_id`. (A `source_md5` vs local‑id split is a clean v2 if local imports ever land.)
- **No IPC codegen/Zod layer in v1.** That's an infra project of its own. The drift risk is mitigated by: `tsc` failing the build if `SanCitroApi` drifts, and **runtime payload validators at every Python handler** (the real trust boundary). Codegen = noted v2.
- **Player is audiobook‑complete but not maximal.** v1: play/pause, scrub, prev/next chapter, ±10/30 s skip, speed, sleep timer, chapter+time‑remaining, resume, error states, keyboard + ARIA. Deferred v2: OS media‑session, chapter search, inline bookmark editing, manual chapter reorder/relabel/relink.

### Grounded facts the plan depends on (verified in code)
- `download_history.py._ensure_table()` creates tables via `CREATE TABLE IF NOT EXISTS` — **not** `migrations.py`. New tables live here; the broken‑v4 `^[a-z_]+$` validator never applies. (Still: no digits in column names.)
- `_connect()` (download_history.py:23) does **not** set `PRAGMA foreign_keys` → must add `PRAGMA foreign_keys = ON` for cascade. Safe: no existing FKs.
- CSP block exists (main.ts:212) with **no `media-src`** → `<audio>` over a custom scheme is silently blocked until added.
- Navigation is already locked to `san-citro://` (`will-navigate` main.ts:158 + `setWindowOpenHandler` :166). The media scheme is a **subresource** (`<audio src>`), never navigated to.
- The protocol handler breaks on `?query` (path resolution), which is why the reader uses sessionStorage. **`#hash` is client‑side, survives refresh, and never hits the handler** → use it for deep‑link state.
- `handle_resolve_download_path` (bridge_handlers.py:290) is the security template: `validate_writable_dir` → `realpath` → `startswith(out_dir_abs + os.sep)` → exists.
- `web/AGENTS.md`: this is a **modified Next.js** — read `node_modules/next/dist/docs/` before writing renderer code.

---

## Position semantics (define once, used everywhere)
A chapter = a physical audio file + a `start_offset_seconds` within it. Multi‑file: one file per chapter, offset 0. Single `.m4b`: many chapters share one file with increasing offsets.
- **`file_position_seconds`** = `<audio>.currentTime` — absolute within the *physical file*. **This is what we persist**, with `chapter_id`.
- **chapter‑relative** (UI only) = `currentTime − chapter.start_offset_seconds`.
- **logical/book position** (UI only) = Σ(prior chapter durations) + chapter‑relative.
Resume: load progress → `chapter_id` → its file + offset → set `<audio>.src` → on `loadedmetadata`, `currentTime = file_position_seconds`.

---

## Phase A — Backend: classification, schema, safe processing (Python)

### A1. Search detection (tentative hint) — `src/scraper.py`, `bridge_handlers.py`
- `_AUDIO_EXTENSIONS = {"m4b","m4a","mp3","aac","ogg","opus","flac"}` folded into `_FILE_EXTENSIONS`; keep `{"zip","rar"}` out of it.
- Add `content: str | None` kwarg → `&content={content}` so we can request Anna's `content=audiobook` (reliable signal).
- Result gains `content_type` (`"audiobook"`|`"book"`): audiobook if ext ∈ audio, or zip/rar when category=audiobook / card text says "audiobook". **This is a hint only.**
- `handle_search`: pass `params["content"]` through; `content_type` rides along like `is_downloaded`.

### A2. Authoritative classification + decoupled processing
**Decouple from the download lifecycle.** `run_download` stays media‑agnostic. In `electron-app/python/download_manager.py._download_worker_inner`, **after** `run_download` returns success and the `completed` event fires, run a distinct processing phase that emits its own status so the UI shows "Processing audiobook…":

```
downloaded → (process) → processing → ready | unsupported | error
```

New `src/audiobook_processor.py`:
- `classify(file_path, content_hint) -> media_type` — **authoritative**, ignores the renderer's word: inspect real extension; for `.zip` peek the central directory for audio members; decide `audiobook` | `ebook` | `other`. Persist to `downloads.media_type`.
- `process_if_audiobook(md5, file_path, out_dir, history_db, content_hint)` — orchestrates classify → extract → scan/order → persist; sets `audiobooks.status` + `error_message`; idempotent (safe re‑scan / redownload via delete‑then‑insert).
- `extract_archive(...)` — **stdlib `zipfile` only**, hardened, into `<out_dir>/audiobooks/<md5>.tmp/`:
  - Pre‑flight caps (reject before writing bytes): `MAX_FILES=2000`, `MAX_TOTAL_UNCOMPRESSED≈10 GB` (Σ `ZipInfo.file_size` — zip‑bomb guard), `MAX_SINGLE≈2 GB`.
  - Per member reject: absolute paths, `..` after `os.path.normpath`, **symlinks** (`stat.S_ISLNK(zi.external_attr>>16)`), Windows reserved names (`CON,PRN,AUX,NUL,COM1‑9,LPT1‑9`), nested archives; realpath‑contain every target under the tmp dir (zip‑slip). Case‑insensitive duplicate handling.
  - Password‑protected / corrupt / `BadZipFile` → `status='error'`, message; leave nothing behind.
  - **Atomic:** only after a clean scan + DB commit, `os.replace(tmp, final)`. Startup sweep deletes stale `*.tmp` and resets `processing` rows.
  - `.rar` → `status='unsupported'`, `error_message='RAR needs manual extraction'`. No binary dep.
- `scan_and_order(folder) -> list[Chapter]` — collect audio files; **order by**: (1) embedded disc# + track# (mutagen), (2) folder hierarchy (CD/Disc/Part subdirs), (3) natural‑sort filename fallback (inline digit‑run key, no dep). Each → one chapter, offset 0. Title/duration via mutagen (`info.length`; `0.0` if None). Store **rel paths** (relative to `out_dir`).
- `parse_m4b_chapters(path) -> list[Chapter]` — single `.m4b`: parse **Nero `chpl`** (`moov/udta/chpl`) **and** **QuickTime chapter track** (`tref/chap` → text track `stts` durations + sample text). All chapters share the file with increasing offsets; duration = next start − this start. No markers → one chapter (correct). Hand‑rolled MP4 box walker; **highest‑risk module → most tests** + `__main__` self‑check on both forms.

**Dependency: `mutagen~=1.47`** in `pyproject.toml` (pure‑Python; no ffmpeg). **Risk:** must ship inside the bundled Python — verify the PyInstaller spec (`electron-app/` build) bundles it (hiddenimports/site‑packages); add to verification.

### A3. SQLite — `src/download_history.py`
Add `PRAGMA foreign_keys = ON` to `_connect()`. New tables in `_ensure_table()` (no digits in column names):

```sql
ALTER TABLE downloads ADD COLUMN media_type TEXT;   -- guarded: skip if column exists; backfill on startup from extension/path

CREATE TABLE IF NOT EXISTS audiobooks (
    md5 TEXT PRIMARY KEY,
    container_type TEXT,                 -- 'file' | 'zip' | 'rar'
    folder_path TEXT,                    -- rel to out_dir; NULL for single in-place file
    total_duration_seconds REAL,
    track_count INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','ready','unsupported','error')),
    error_message TEXT,
    created_at TIMESTAMP, updated_at TIMESTAMP);

CREATE TABLE IF NOT EXISTS audiobook_chapters (
    chapter_id INTEGER PRIMARY KEY AUTOINCREMENT,
    md5 TEXT NOT NULL REFERENCES audiobooks(md5) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    rel_path TEXT NOT NULL,              -- audio file, relative to out_dir
    file_size INTEGER, title TEXT,
    start_offset_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL,
    UNIQUE (md5, chapter_index));

CREATE TABLE IF NOT EXISTS audiobook_progress (
    md5 TEXT PRIMARY KEY REFERENCES audiobooks(md5) ON DELETE CASCADE,
    chapter_id INTEGER REFERENCES audiobook_chapters(chapter_id) ON DELETE SET NULL,
    file_position_seconds REAL, updated_at TIMESTAMP);

CREATE TABLE IF NOT EXISTS audiobook_bookmarks (
    bookmark_id INTEGER PRIMARY KEY AUTOINCREMENT,
    md5 TEXT NOT NULL REFERENCES audiobooks(md5) ON DELETE CASCADE,
    chapter_id INTEGER, file_position_seconds REAL NOT NULL,
    label TEXT, created_at TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_chapters_md5  ON audiobook_chapters(md5);
CREATE INDEX IF NOT EXISTS idx_bookmarks_md5 ON audiobook_bookmarks(md5);
```

Functions (existing `_ensure_table`→`_connect`→parameterized→commit style): `record_audiobook` (upsert, sets `updated_at`), `replace_chapters` (delete+bulk insert in one tx), `get_audiobook`, `get_audiobook_chapters`, `get_chapter` (by `chapter_id`, used by media protocol), `list_audiobooks` (join `downloads.title`), `get/save_audiobook_progress`, `add_bookmark`→id, `list_bookmarks`, `delete_bookmark(md5, bookmark_id)` (**ownership‑checked**), `delete_audiobook(md5)` (cascade), `backfill_media_type` (startup), `reset_stuck_audiobooks` (startup).

---

## Phase B — Electron main: streaming protocol + validated RPC/IPC (TypeScript)

### B1. `san-citro-media://` — least‑privilege streaming
- Register privileged alongside `san-citro` (main.ts:96): `{ scheme:'san-citro-media', privileges:{ standard:true, secure:true, stream:true } }` — **no `corsEnabled`, no `supportFetchAPI`** (`<audio src>` needs neither).
- `registerMediaProtocol()` via **`protocol.handle`**, called after `registerProtocol()` (main.ts:193). URL `san-citro-media://track/<md5>/<chapterId>`:
  - Validate `^[a-f0-9]{32}$` md5; integer‑bounds `chapterId`; resolve abs path via `bridge.call('resolve_track_path',{md5,chapter_id})` (returns null → 404).
  - `fs.stat` size; MIME by ext (mp3→audio/mpeg, m4a/m4b/aac→audio/mp4, ogg/opus→audio/ogg, flac→audio/flac).
  - **Defensive Range:** parse a single `bytes=start-end`; **reject multi‑range** (comma) → 200 full or 416; clamp `end`; `start≥size`→416 with `Content-Range: bytes */size`. Respond 206 `fs.createReadStream(abs,{start,end})` via `Readable.toWeb`, headers `Content-Range`/`Content-Length`/`Accept-Ranges: bytes`. No Range → 200 stream.
  - **Why streaming+Range, not the ArrayBuffer path** (`READ_BOOK_FILE`): audiobooks are 60–800 MB; whole‑file‑into‑memory + structured clone stalls seconds and spikes renderer memory, and seeking re‑buffers everything. `<audio>` issues Range natively; 206 starts <1 s and seeks instantly.
- **CSP (critical):** main.ts:217 add `media-src 'self' san-citro-media:;` (no `blob:` needed).

### B2. `resolve_track_path` RPC — `bridge_handlers.py` (mirror `resolve_download_path:290`)
`get_chapter(md5, chapter_id)` → join `rel_path` to `out_dir`; **realpath‑contain** (`startswith(out_dir_abs+os.sep)`, Windows `os.path.normcase`); **reject symlink/junction** (compare `realpath` to `os.lstat`/no‑reparse); exists; re‑validated every request so a poisoned DB row can't escape. Main‑process only (not on `SanCitroApi`).

### B3. New RPCs + IPC channels + **runtime validation**
Per channel: `electron-app/src/types.ts` (`IPC_CHANNELS`) → `preload.ts` (inlined channel copy **and** api method — inline is required under `sandbox:true`; add a tiny test asserting the two channel maps match) → `ipc-handlers.ts` (`bridge.call`) → `web/src/lib/api-client.ts` + `web/src/types` (`SanCitroApi`).

| api-client | RPC | validation at handler |
|---|---|---|
| `listAudiobooks()` | `list_audiobooks` | — |
| `getAudiobookDetail(md5)` | `get_audiobook_detail` | md5 |
| `getAudiobookProgress(md5)` / `saveAudiobookProgress(md5,chapterId,seconds)` | `get/save_audiobook_progress` | md5, int chapterId, finite `0≤s≤MAX` |
| `addBookmark(md5,chapterId,seconds,label)` / `listBookmarks(md5)` / `deleteBookmark(md5,bookmarkId)` | `add/list/delete_bookmark` | + label length cap; **delete checks bookmark.md5==md5** |
| `rescanAudiobook(md5)` / `deleteAudiobook(md5)` | `rescan_audiobook` / `delete_audiobook` | md5 |

Add `_validate_index`, `_validate_seconds`, `_validate_label` helpers next to `_validate_md5`. Reject `NaN/Inf/negative/oversized` — TS types don't protect the Python boundary. Also extend `SearchParams` with `content?` and the result type with `content_type`.

---

## Phase C — Renderer: search, Library, detail, player (React/TS; read Next docs first)

- **Search** (`web/src/app/search/page.tsx`): Headphones badge when `content_type==='audiobook'`; an Audiobook/Book filter passing `content` to `search()`.
- **Nav** (`app-sidebar.tsx:39`): add `{ label:'Library', href:'/library', icon: Library }`. SPA fallback already serves `library.html`.
- **Deep‑link via `#hash`, not sessionStorage** (survives refresh): `audiobook.html#<md5>`, `player.html#<md5>/<chapterId>`. Read on mount + `hashchange`.
- **`library/page.tsx`** — two tabs via plain `useState` (no Tabs primitive; ~12 lines of two `Button`s). Books = `downloads` where `media_type!=='audiobook'` & completed; Audiobooks = `listAudiobooks()` with per‑row status (Ready / Processing… / Unsupported / Error). Row actions: open, re‑scan, delete (confirm).
- **`audiobook/page.tsx`** — header (title, total duration, count, status); ordered chapter list; per‑chapter "Play" → `player.html#<md5>/<chapterId>`. Unsupported/error states show the message + "Show in folder".
- **`player/page.tsx`** — mirror `reader/page.tsx` structure (loading/error/empty guards, drawer, control bar, a11y):
  - Mount: parse hash; `getAudiobookDetail` → chapters; `getAudiobookProgress` → resume.
  - One `<audio ref>`; `src = san-citro-media://track/<md5>/<chapterId>`. Switch chapter: same file → just set `currentTime`; else reset `src` + `load()`.
  - **Resume** only inside `loadedmetadata`, guarded by `didResumeRef` (set‑before‑metadata is a no‑op — the classic bug).
  - Controls: play/pause; scrubber (`currentTime`/`duration`+`timeupdate`); prev/next chapter; **±10/30 s**; **speed 0.5–3×** (`playbackRate`); **sleep timer**; current chapter + **time remaining**; auto‑advance on `ended`.
  - **Error handling:** `<audio>` `error` event → "Can't play this file" (unsupported codec / corrupt / missing).
  - **Persist via IPC, not telemetry:** throttle `saveAudiobookProgress(md5, chapterId, currentTime)` ~5–10 s on `timeupdate` + on pause / chapter change / unmount.
  - **Bookmarks:** add → `addBookmark`; drawer lists `listBookmarks`, click to jump (set chapter + `currentTime`), `deleteBookmark(md5, id)`.
  - **Keyboard:** space=play/pause, ←/→=skip, ARIA on all controls.

### Codec support matrix (don't overpromise)
Electron bundles FFmpeg with proprietary codecs → **playable:** mp3, m4a/m4b/aac (audio/mp4), flac, ogg/opus, wav. **Detection/tags/duration:** all of the above (mutagen). **Chapter extraction:** `.m4b` only. The player surfaces failures via the `error` event rather than assuming success — **verify real playback in testing, not just headers.**

---

## Ranked risks
1. CSP `media-src` omission → silent `<audio>` failure (B1).
2. `mutagen` missing from the **packaged** Python bundle (works in dev, fails shipped) — verify spec.
3. `.m4b` QuickTime/`chpl` parsing (byte layout) — heaviest module; self‑checks + adversarial tests.
4. Extraction safety (zip‑bomb/slip/symlink) — pre‑flight caps + realpath containment, atomic temp→rename.
5. Resume timing (`loadedmetadata`) and chapter switching (`src` reset + `load()`).
6. FK pragma now enforced on the shared connection — confirm no existing code relied on dangling refs (none found).
7. Detection heuristics — trust authoritative post‑download classify; search badge is cosmetic.
8. preload/types channel‑map drift — guarded by `tsc` + the equality test.

## Phasing & verification (each phase independently testable)
- **A (backend):** pytest for processing (multi‑file order; `.m4b` chpl + QuickTime + marker‑less; zip‑slip; zip‑bomb reject; symlink/reserved‑name/absolute‑path reject; corrupt/password zip → error; atomic temp→rename; rar→unsupported) and history (round‑trip, cascade delete, progress save/restore by chapter_id, bookmark add/list/ownership‑checked delete, media_type backfill). Keep ruff/mypy + the 137 existing tests green.
- **B (protocol/RPC):** unit‑test Range parsing (normal/no‑range/past‑EOF→416/multi‑range‑reject/zero‑byte), `resolve_track_path` containment (path outside out_dir → null; symlink → null), validator rejection (NaN/Inf/neg/oversized/bad md5).
- **C (renderer) — live app:** search → Audiobook badge + filter. Download a **zipped multi‑file** audiobook → extraction into `audiobooks/<md5>/`, Library shows one entry transitioning Processing→Ready, detail lists ordered chapters. Play → fast start + scrub works (Range). Switch chapters, ±30 s, 1.5× speed, sleep timer, add a bookmark. **Quit + relaunch** → resumes at saved position; bookmark persists. Repeat with a single **`.m4b`** → internal chapters list + per‑chapter seek. Trigger an unsupported file → friendly error. Re‑scan and delete (folder reclaimed). DevTools console clean of CSP/media errors.
- **D (hardening):** packaged build smoke test (mutagen present; audio plays in the installed app); restart‑during‑extraction (stale `.tmp` swept) and restart‑during‑playback; duplicate titles; deleted extracted folder surfaces an error, not a crash; refresh on the player page restores via hash.
