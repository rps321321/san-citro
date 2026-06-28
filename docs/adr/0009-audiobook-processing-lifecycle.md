# Audiobook processing: a decoupled, spec-sized queue with peek-gating and sweep recovery

Post-download audiobook processing (archive extract → ffprobe → chapter build) is a
**separate subsystem** from the download workers, resolving the review's HIGH concern that a
download is `completed` (and its `download_analytics` terminal row fires) the instant bytes
land — *before* processing exists.

## Decisions

- **Status separation.** The download keeps its transport lifecycle (`queued → downloading →
  completed`; terminal = bytes done, telemetry unchanged). Audiobook processing has its **own**
  status in the `audiobooks` table: `pending → processing → ready | unsupported | error`. The
  Library shows "Processing…" off that status, not the download's.
- **Decoupled queue + spec-sized pool.** Processing runs in its own queue/worker pool, not on
  download slots (a slow extraction never blocks a download). Pool size is computed at startup:
  **1 on HDD/unknown; `max(1, min(cores//2, 3))` on SSD** (extraction is disk-I/O-bound — disk
  type dominates), cap 3, serial fallback if detection fails; re-evaluated if `out_dir` changes.
- **Peek-gated enqueue.** On completion, every archive (`zip/rar/7z`) gets a cheap `7z l`
  (list, no extract). **Audio members inside → enqueue full extract+ffprobe** as an audiobook;
  otherwise leave it a plain archive file. Authoritative (catches keyword-mislabeled audiobooks),
  no wasteful extraction of book-archives. The `(Audiobook)` keyword is a UI hint only.
- **Not user-cancellable.** Processing is a fast local step; **Delete** (cascade-remove the
  audiobook rows + extracted folder) covers removal.
- **Sweep recovery.** Bridge startup (next to `cleanup_orphaned_downloads`) resets any stuck
  `processing` row to `pending`, deletes stale `<md5>.tmp`, and re-enqueues. Re-extraction is
  idempotent (delete-tmp-then-extract; the downloaded archive is still on disk).
- **Failure isolation.** A processing exception sets `audiobooks.status='error'` + message and
  **never touches the `downloads` row** — the archive remains a valid, Show-in-folder-able file.

## Consequences

- A new in-memory processing queue + worker(s) + a startup sweep hook in `bridge.main()`.
- The audiobook UI is driven by the `audiobooks.status`, decoupled from download progress.
