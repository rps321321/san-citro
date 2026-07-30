# Issue #1 — Deepen Library, telemetry, SQLite, and desktop command modules

Implementation plan for GitHub issue #1. Deliver in **strict dependency order**. Each phase must pass its focused tests before the next begins. No new production dependencies. Preserve user-visible behavior.

**Gates (final):** offline Python suite green (baseline ~319), Electron `tsc` green, renderer lint (no new errors), renderer production build.

**Domain terms (CONTEXT.md):** Library, Library item, Book, Audiobook, Artifact, Category, Telemetry fact, Telemetry context, Emit boundary, Download lifecycle, Terminal event.

---

## Phase 1 — SQLite schema evolution

### Goal

One explicit, forward-only, versioned schema-evolution module is the sole production owner of SQLite shape. CLI and Python bridge run it **before** any query, cleanup, queue recovery, or command registration that depends on persisted data.

### Current state (as of issue start)

| Path | Role |
|------|------|
| `src/migrations.py` | Decorator registry + `run_migrations`; migrations 1–5 create `schema_version`, partial `downloads`, **and** obsolete `records` / `ingest_metadata` |
| `src/download_history.py` | Lazy `_ensure_table` + `_migrate_meta_columns` (production path today) |
| `src/audiobook_db.py` | Lazy `_ensure_audiobook_tables` |
| `src/cli.py` | Calls `init_downloads_table`, not `run_migrations` |
| `electron-app/python/bridge.py` | Calls `cleanup_orphaned_downloads` on startup, not `run_migrations` |
| `tests/test_migrations.py` | Exists; does not cover audiobook tables or production entry wiring |

### Required design

1. **Public interface** (deep module surface; tests target this):
   - `run_migrations(db_path: str) -> int` — apply pending migrations; return count applied.
   - `get_current_version(db_path: str) -> int`
   - Keep connection policy: WAL, busy_timeout, NORMAL synchronous, foreign_keys ON, row_factory where appropriate. Prefer reusing `download_history._connect` pragmas for consistency, or document one shared connect helper.

2. **Canonical new-database shape** (after latest version):
   - `schema_version(version, applied_at, description)`
   - `downloads` with base columns **and** metadata: `author`, `year`, `extension`, `content_type`, `language`, `publisher`, `cover_url`, `media_type` (+ existing status/size/timestamps). Indexes for status/started_at (and any other already used).
   - Full audiobook tables matching current `audiobook_db` DDL: `audiobooks`, `audiobook_chapters`, `audiobook_progress`, `audiobook_bookmarks` + their indexes and FKs.
   - **Do NOT** create `records` or `ingest_metadata` on new databases.

3. **Legacy preservation:**
   - If `records` / `ingest_metadata` already exist, leave them untouched (no DROP, no rewrite).
   - Remove or rewrite old migrations that force-create those tables on empty DBs. Prefer additive new migrations + adoption logic over rewriting already-shipped version numbers if tests/history depend on them — but production never ran these migrations, so consolidating the registered set is acceptable if tests are updated. Goal: empty DB after `run_migrations` has no bulk-metadata tables; unversioned history DB with only `downloads` gets version tracking + missing columns/tables without data loss.

4. **Adoption of unversioned production DBs:**
   - Introspect tables/columns; add missing pieces idempotently (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER TABLE ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`).
   - Record baseline version only after successful completion.
   - Preserve all rows and FK relationships (audiobook progress/chapters/bookmarks).

5. **Transactional integrity:**
   - Each migration in its own transaction; version row inserted only on success; failure rolls back and re-raises (fail startup clearly).
   - Second run applies 0 migrations.

6. **Wire production entry points:**
   - CLI (`src/cli.py`): call `run_migrations(history_db)` before first DB use (replace or precede `init_downloads_table`).
   - Bridge (`electron-app/python/bridge.py`): call `run_migrations` before orphan cleanup / audiobook resweep.
   - Fail loudly if schema evolution fails (do not continue against partial schema). Soft-catch only for non-schema best-effort tasks after evolution succeeds.

7. **Remove lazy DDL ownership** from download-history and audiobook modules after entry points call schema evolution:
   - `_ensure_table` / `_ensure_audiobook_tables` should not invent schema. Options (pick simplest that keeps tests green): (a) make them call `run_migrations` once, or (b) no-op after documenting that callers must migrate first, and update all call sites/tests to run migrations. Prefer (a) as a safety net so isolated unit tests still work, but production must still call evolution explicitly at startup.
   - Keep query modules focused; do not merge all query code into `migrations.py`.

### Phase 1 tests (TDD preferred)

- New empty temp DB → complete canonical shape + current version; no `records`/`ingest_metadata`.
- Unversioned downloads-only DB with sample rows → metadata preserved, version established, meta columns present.
- Unversioned DB with audiobook tables + progress → rows and FKs survive.
- Partial/older schema → missing columns/indexes added idempotently.
- Run twice → second run applies 0.
- Inject failing migration → transaction rolls back, version not recorded (can use a temporary registered migration in the test or a test hook if needed).
- CLI and bridge startup paths call schema evolution before first DB behavior (assert via mock/spy or structural test).
- Existing `test_migrations.py`, `test_download_history.py`, `test_audiobook_db.py` stay green (adapt fixtures to migrate first if needed).

### Phase 1 verification command

```text
python -m pytest tests/test_migrations.py tests/test_download_history.py tests/test_audiobook_db.py tests/test_cli.py tests/test_bridge_handlers.py -q --tb=short
```

---

## Phase 2 — DB-driven Library

### Goal

One Library query module owns SQLite joins, Books/Audiobooks selection, filters, sorting, and facet derivation. Renderer owns only transient view state and presentation. Fulfills ADR-0006.

### Current state

| Path | Role |
|------|------|
| `src/download_history.list_library` | Completed downloads only; no `media_type`; no filters/sort/facets |
| `src/audiobook_db` | Separate audiobook list/detail joins |
| `web/src/routes/library.tsx` | Client-side filter/sort/facets; separate Books vs Audiobooks fetches |
| Bridge | `list_library` + `list_audiobooks` handlers |

### Required design

1. **Library item model** (shared core + variant):
   - Core: stable `md5`, title, author, cover, completion metadata (`completed_at`, filesize, etc.).
   - **Book** variant: format/reading fields (`extension`, language, content_type/publisher as applicable).
   - **Audiobook** variant: processing status, duration, track_count, folder/container, playback-related fields already exposed today.
   - Classification from authoritative DB `media_type` (backend after artifact inspection). Do **not** re-infer in the renderer. Treat NULL completed rows per existing backfill policy (`book` when appropriate).

2. **Deep module** (e.g. `src/library.py` or a clearly named query API on an existing module — prefer new focused module if it deepens the seam):
   - Input: optional filters (category/content_type, format/extension, language, media kind books|audiobooks|all), sort key (author|year|title|recent).
   - Output: items (variant-tagged) **and** facets derived from the **same eligibility rules** as items (not from a different query population).
   - Stable ordering for ties; deterministic null handling.
   - No pagination; full filtered local result.
   - Empty library vs no-match-after-filter must be distinguishable if the UI needs both (document in return shape, e.g. total eligible before filter vs filtered count, or separate fields).

3. **Bridge / IPC:**
   - Prefer one Library list interface for the page (params for tab/filter/sort). Detail and player commands stay separate.
   - Keep backward-compatible behavior where cheap; if `list_library` gains params, update Electron IPC + preload + renderer types + api-client together.
   - Audiobook **detail** / progress / play remain distinct commands.

4. **Renderer:**
   - Drop client-side reconstruction of classification/sort/filter/facet logic that the DB now owns.
   - Keep: grid/list toggle (localStorage), loading/error/retry, tab selection as view state that drives query params, DetailSheet, play controls, processing badges from returned variant fields.
   - Preserve empty, loading, grid/list, detail, processing-status, reader entry, in-page player behavior.

### Phase 2 tests

- Real temp SQLite: Books, ready Audiobooks, processing Audiobooks, missing optional metadata, identical sort keys.
- Core shared identity; distinct variant details.
- `media_type` controls classification.
- Every supported filter and sort via module interface.
- Facets match eligible data rules.
- Stable ties / nulls.
- Empty vs no-match.
- Bridge handler tests updated; prior download-history / audiobook join tests adapted.

### Phase 2 verification

```text
python -m pytest tests/test_library.py tests/test_download_history.py tests/test_audiobook_db.py tests/test_bridge_handlers.py -q --tb=short
```

(Create `tests/test_library.py` if the module is new.)

---

## Phase 3 — Renderer telemetry deep module

### Goal

Capture modules submit **typed telemetry facts**. One deep renderer telemetry module owns table mapping, row construction, telemetry context, app version, auth headers, delivery, logging policy, flush coordination. Preserve ADR-0001–0003; best-effort memory-only; never break product flows.

### Current state

| Path | Role |
|------|------|
| `web/src/lib/telemetry.ts` | Device/session IDs, batch queue, `sendToSupabase`, many track helpers |
| `web/src/lib/heatmap.ts` | Own flush timers + direct Supabase fetch; imports IDs from telemetry |
| `web/src/lib/session-recorder.ts` | Own flush + direct fetch for `replay_chunks` |
| Python | Separate bridge emitter (keep; do not merge languages) |

### Required design

1. **Public fact API** (examples; exact names free if clear):
   - Typed methods or a small closed set of fact kinds → table-specific rows.
   - Capture modules must not pass arbitrary table names + raw rows for ordinary product facts (heatmap/replay can be first-class fact categories with their own policies).

2. **Owned by deep module:** table mapping, row construction, shared telemetry context fields, app version, headers, delivery, logging, flush coordination.

3. **Policies (preserve behavior):**
   - Ordinary facts: shared batch queue (current ~30s / max batch size).
   - Heatmap: suitable batch intervals (existing click/mouse/scroll timings).
   - Replay: bounded chunks (existing interval/buffer).
   - Missing Supabase config → silent no-op.
   - Network / non-2xx → log warn, never reject into callers.
   - Stop/flush: best-effort flush in-memory; no durable queue.

4. **Do not:** expand/remove captured events, change masking, add disk persistence, merge Python transport.

5. **Handoff:** renderer → Python telemetry context (`setTelemetryContext`) remains intact.

### Phase 3 tests

- Add renderer tests (Vitest/Jest if present; otherwise minimal Node test harness already used in repo — check `web/package.json`; if no test runner, add a lightweight vitest devDependency **only if** the project already expects it, else colocate pure-logic tests and keep network behind injectible transport). Prefer injectible `fetch`/transport + fake timers.
- Fact categories → correct table rows + one shared context.
- Batch/flush policies per category.
- Missing config no-op; failures never throw to callers.
- Stop flushes without durable state.
- Context handoff still works (unit or integration at api-client/preload boundary if practical).

### Phase 3 verification

```text
# Renderer unit tests for telemetry (path depends on harness chosen)
# Plus: cd web && npx tsc --noEmit  (or project script)
# Ensure no new lint errors on touched files
```

---

## Phase 4 — Desktop command path

### Goal

Central descriptor for **Python-backed** desktop commands (IPC channel, JSON-RPC method, invocation mode). Simple relays register from one implementation. Explicit adapters remain for security seams. Contract tests keep all representations in sync. Remove retired WebContentsView player command surface (ADR-0013).

### Current state

| Layer | Path |
|-------|------|
| IPC constants | `electron-app/src/types.ts` `IPC_CHANNELS` |
| Preload allowlist | `electron-app/src/preload.ts` (inlined channels; sandbox) |
| Electron handlers | `electron-app/src/ipc-handlers.ts` |
| Bridge transport | `electron-app/src/python-bridge.ts` |
| Python registry | `electron-app/python/bridge_handlers.py` + `bridge.py` |
| Renderer types | `web/src/types/index.ts` `window.sanCitro` |
| Dead-ish player IPC | `PLAYER_LOAD`, `PLAYER_SET_MODE`, `PLAYER_REQUEST_MODE` in types; ADR-0013 in-page player uses `playAudiobook` + progress |

### Required design

1. **Descriptor module** (e.g. `electron-app/src/python-commands.ts` or similar): list of Python-backed simple relays with channel, RPC method, mode.

2. **Registration:** one loop/helper registers simple Electron→Python relays. Composite commands stay explicit (`playAudiobook` multi-step, etc.).

3. **Keep explicit:**
   - Sandboxed preload allowlist (self-contained; no local requires).
   - Renderer typed API (domain types, not untyped generated goo).
   - Python `register_handlers` allowlist.
   - OS-affecting: shell open, dialogs, updater, window controls, media protocol validation.

4. **Contract tests:** descriptor ⊆ preload exposure ⊆ renderer interface ⊆ Electron registration ⊆ Python registry (and reverse: no orphan Python-only or preload-only names for the Python-backed set). Retired player channels absent everywhere.

5. **Remove** retired WebContentsView-only channels/functions with no callers after ADR-0013 (`PLAYER_LOAD`, `PLAYER_SET_MODE`, `PLAYER_REQUEST_MODE` if unused). Keep `playAudiobook`, progress, and any still-used player chrome IPC (`PLAYER_ACTIVE` only if still referenced — verify before deleting).

6. **Transport:** timeouts, process exit, correlation, error translation stay in python-bridge module (deepen there if duplicated).

7. No code generation; no new production dependency solely for allowlists.

### Phase 4 tests

- Contract test file for command agreement.
- Relay registration with fake IPC + fake bridge.
- Composite/OS commands via their explicit interfaces.
- Malformed params rejected at trusted seam.
- Existing media-protocol + bridge-handler tests remain green.

### Phase 4 verification

```text
cd electron-app && npx tsc --noEmit
python -m pytest tests/test_bridge_handlers.py -q --tb=short
# + any new contract tests under electron-app
```

---

## Final regression gates

```text
python -m pytest -q --tb=line
cd web && npm run lint   # no new errors
cd web && npm run build  # static export for Electron
cd electron-app && npx tsc --noEmit
# electron-app existing tests if present (e.g. media-protocol)
```

Update docs/comments that describe lazy-DDL-only schema or WebContentsView player commands when you touch those areas. No drive-by refactors.

---

## Commit policy

- Commit on the current branch after all phases pass gates.
- Use a clear multi-line message summarizing the four deepenings.
- Do **not** force-push; do **not** push unless explicitly asked.
- No `Co-Authored-By: Claude` or similar trailers.
