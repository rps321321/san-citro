"""Tests for the lightweight database migration system (Phase 1 schema evolution)."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src import migrations as migrations_mod
from src.migrations import (
    SchemaMigrationError,
    get_current_version,
    get_migration_history,
    get_registered_migrations,
    run_migrations,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _table_exists(db_path: str, table_name: str) -> bool:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,),
        ).fetchone()
        return row[0] > 0


def _get_columns(db_path: str, table_name: str) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        return {row[1] for row in rows}


def _index_exists(db_path: str, index_name: str) -> bool:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
            (index_name,),
        ).fetchone()
        return row[0] > 0


_DOWNLOAD_CORE = {
    "md5",
    "title",
    "filename",
    "status",
    "started_at",
    "completed_at",
    "filesize_bytes",
    "error",
}
_DOWNLOAD_META = {
    "author",
    "year",
    "extension",
    "content_type",
    "language",
    "publisher",
    "cover_url",
    "media_type",
}
_AUDIOBOOK_TABLES = {
    "audiobooks",
    "audiobook_chapters",
    "audiobook_progress",
    "audiobook_bookmarks",
}


# ---------------------------------------------------------------------------
# Tests: version tracking
# ---------------------------------------------------------------------------


class TestGetCurrentVersion:
    def test_should_return_zero_when_database_does_not_exist(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "nonexistent.db")
        assert get_current_version(db_path) == 0

    def test_should_return_zero_when_schema_version_table_missing(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "bare.db")
        sqlite3.connect(db_path).close()
        assert get_current_version(db_path) == 0

    def test_should_return_latest_version_after_migrations(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "migrated.db")
        run_migrations(db_path)
        all_migs = get_registered_migrations()
        assert get_current_version(db_path) == all_migs[-1].version


class TestGetMigrationHistory:
    def test_should_return_empty_list_for_fresh_database(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "fresh.db")
        assert get_migration_history(db_path) == []

    def test_should_return_all_applied_entries(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "hist.db")
        run_migrations(db_path)
        history = get_migration_history(db_path)
        all_migs = get_registered_migrations()
        assert len(history) == len(all_migs)
        assert history[0]["version"] == 1


# ---------------------------------------------------------------------------
# Tests: migration runner
# ---------------------------------------------------------------------------


class TestRunMigrations:
    def test_should_apply_all_migrations_on_fresh_database(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "new.db")
        all_migs = get_registered_migrations()
        applied = run_migrations(db_path)
        assert applied == len(all_migs)
        assert get_current_version(db_path) == all_migs[-1].version

    def test_should_be_idempotent_on_repeated_calls(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "idem.db")
        first = run_migrations(db_path)
        second = run_migrations(db_path)
        assert first > 0
        assert second == 0

    def test_should_skip_already_applied_migrations(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "partial.db")
        run_migrations(db_path)
        version_before = get_current_version(db_path)
        applied = run_migrations(db_path)
        assert applied == 0
        assert get_current_version(db_path) == version_before


# ---------------------------------------------------------------------------
# Tests: canonical new-database shape
# ---------------------------------------------------------------------------


class TestCanonicalShape:
    def test_should_create_schema_version_table(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "v1.db")
        run_migrations(db_path)
        assert _table_exists(db_path, "schema_version")
        cols = _get_columns(db_path, "schema_version")
        assert {"version", "applied_at", "description"} <= cols

    def test_should_create_downloads_with_full_metadata_columns(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "downloads.db")
        run_migrations(db_path)
        assert _table_exists(db_path, "downloads")
        cols = _get_columns(db_path, "downloads")
        assert _DOWNLOAD_CORE | _DOWNLOAD_META <= cols

    def test_should_create_downloads_indexes(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "dlidx.db")
        run_migrations(db_path)
        assert _index_exists(db_path, "idx_downloads_status")
        assert _index_exists(db_path, "idx_downloads_started_at")

    def test_should_create_all_audiobook_tables_and_indexes(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "audio.db")
        run_migrations(db_path)
        for name in _AUDIOBOOK_TABLES:
            assert _table_exists(db_path, name), f"missing table {name}"
        assert _index_exists(db_path, "idx_chapters_md5")
        assert _index_exists(db_path, "idx_bookmarks_md5")

    def test_should_not_create_records_or_ingest_metadata_on_empty_db(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "no_bulk.db")
        run_migrations(db_path)
        assert not _table_exists(db_path, "records")
        assert not _table_exists(db_path, "ingest_metadata")

    def test_should_preserve_preexisting_records_and_ingest_tables(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "legacy_bulk.db")
        with sqlite3.connect(db_path) as conn:
            conn.execute("CREATE TABLE records (md5 TEXT PRIMARY KEY, title TEXT)")
            conn.execute("INSERT INTO records (md5, title) VALUES ('abc', 'Keep Me')")
            conn.execute(
                "CREATE TABLE ingest_metadata (filename TEXT PRIMARY KEY, file_size INTEGER)"
            )
            conn.execute("INSERT INTO ingest_metadata (filename, file_size) VALUES ('x.jsonl', 10)")
            conn.commit()

        run_migrations(db_path)

        assert _table_exists(db_path, "records")
        assert _table_exists(db_path, "ingest_metadata")
        with sqlite3.connect(db_path) as conn:
            title = conn.execute("SELECT title FROM records WHERE md5 = 'abc'").fetchone()[0]
            size = conn.execute(
                "SELECT file_size FROM ingest_metadata WHERE filename = 'x.jsonl'"
            ).fetchone()[0]
        assert title == "Keep Me"
        assert size == 10
        # Must not invent bulk-metadata columns/indexes — leave untouched.
        cols = _get_columns(db_path, "records")
        assert cols == {"md5", "title"}


# ---------------------------------------------------------------------------
# Tests: unversioned / partial adoption
# ---------------------------------------------------------------------------


class TestUnversionedAdoption:
    def test_should_adopt_unversioned_downloads_only_db_preserving_rows(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "history_only.db")
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                CREATE TABLE downloads (
                    md5 TEXT PRIMARY KEY,
                    title TEXT,
                    filename TEXT,
                    status TEXT,
                    started_at TIMESTAMP,
                    completed_at TIMESTAMP,
                    filesize_bytes INTEGER,
                    error TEXT
                )
                """
            )
            conn.execute(
                "INSERT INTO downloads (md5, title, status) VALUES ('legacy1', 'Old Book', 'completed')"
            )
            conn.commit()

        applied = run_migrations(db_path)
        assert applied == len(get_registered_migrations())
        assert get_current_version(db_path) == get_registered_migrations()[-1].version

        cols = _get_columns(db_path, "downloads")
        assert _DOWNLOAD_META <= cols
        for name in _AUDIOBOOK_TABLES:
            assert _table_exists(db_path, name)

        with sqlite3.connect(db_path) as conn:
            row = conn.execute(
                "SELECT title, status, author FROM downloads WHERE md5 = 'legacy1'"
            ).fetchone()
        assert row[0] == "Old Book"
        assert row[1] == "completed"
        assert row[2] is None

    def test_should_preserve_audiobook_rows_and_foreign_keys(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "with_audio.db")
        md5 = "a" * 32
        with sqlite3.connect(db_path) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute(
                """
                CREATE TABLE downloads (
                    md5 TEXT PRIMARY KEY,
                    title TEXT,
                    filename TEXT,
                    status TEXT,
                    started_at TIMESTAMP,
                    completed_at TIMESTAMP,
                    filesize_bytes INTEGER,
                    error TEXT
                )
                """
            )
            conn.execute(
                "INSERT INTO downloads (md5, title, status) VALUES (?, 'Audio Title', 'completed')",
                (md5,),
            )
            conn.execute(
                """
                CREATE TABLE audiobooks (
                    md5 TEXT PRIMARY KEY,
                    container_type TEXT,
                    folder_path TEXT,
                    total_duration_seconds REAL,
                    track_count INTEGER,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','ready','unsupported','error')),
                    error_message TEXT,
                    created_at TIMESTAMP,
                    updated_at TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE audiobook_chapters (
                    chapter_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    md5 TEXT NOT NULL REFERENCES audiobooks(md5) ON DELETE CASCADE,
                    chapter_index INTEGER NOT NULL,
                    rel_path TEXT NOT NULL,
                    file_size INTEGER,
                    title TEXT,
                    start_offset_seconds REAL NOT NULL DEFAULT 0,
                    duration_seconds REAL,
                    UNIQUE (md5, chapter_index)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE audiobook_progress (
                    md5 TEXT PRIMARY KEY REFERENCES audiobooks(md5) ON DELETE CASCADE,
                    chapter_id INTEGER REFERENCES audiobook_chapters(chapter_id) ON DELETE SET NULL,
                    file_position_seconds REAL,
                    updated_at TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE audiobook_bookmarks (
                    bookmark_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    md5 TEXT NOT NULL REFERENCES audiobooks(md5) ON DELETE CASCADE,
                    chapter_id INTEGER,
                    file_position_seconds REAL NOT NULL,
                    label TEXT,
                    created_at TIMESTAMP
                )
                """
            )
            conn.execute(
                "INSERT INTO audiobooks (md5, status, track_count) VALUES (?, 'ready', 2)",
                (md5,),
            )
            conn.execute(
                "INSERT INTO audiobook_chapters (md5, chapter_index, rel_path, title) "
                "VALUES (?, 0, '00.mp3', 'Intro')",
                (md5,),
            )
            chapter_id = conn.execute(
                "SELECT chapter_id FROM audiobook_chapters WHERE md5 = ?", (md5,)
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO audiobook_progress (md5, chapter_id, file_position_seconds) "
                "VALUES (?, ?, 12.5)",
                (md5, chapter_id),
            )
            conn.execute(
                "INSERT INTO audiobook_bookmarks (md5, chapter_id, file_position_seconds, label) "
                "VALUES (?, ?, 5.0, 'mark')",
                (md5, chapter_id),
            )
            conn.commit()

        run_migrations(db_path)

        with sqlite3.connect(db_path) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            assert conn.execute("SELECT status FROM audiobooks WHERE md5 = ?", (md5,)).fetchone()[0] == "ready"
            assert conn.execute("SELECT COUNT(*) FROM audiobook_chapters WHERE md5 = ?", (md5,)).fetchone()[0] == 1
            pos = conn.execute(
                "SELECT file_position_seconds FROM audiobook_progress WHERE md5 = ?", (md5,)
            ).fetchone()[0]
            assert pos == 12.5
            label = conn.execute(
                "SELECT label FROM audiobook_bookmarks WHERE md5 = ?", (md5,)
            ).fetchone()[0]
            assert label == "mark"

            # FK cascade still works after adoption.
            conn.execute("DELETE FROM audiobooks WHERE md5 = ?", (md5,))
            conn.commit()
            assert conn.execute("SELECT COUNT(*) FROM audiobook_chapters").fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM audiobook_progress").fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM audiobook_bookmarks").fetchone()[0] == 0

    def test_should_add_missing_columns_idempotently_on_partial_schema(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "partial_cols.db")
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "CREATE TABLE downloads (md5 TEXT PRIMARY KEY, title TEXT, status TEXT, author TEXT)"
            )
            conn.execute(
                "INSERT INTO downloads (md5, title, status, author) VALUES ('p1', 'Partial', 'completed', 'A')"
            )
            conn.commit()

        run_migrations(db_path)
        cols = _get_columns(db_path, "downloads")
        assert "media_type" in cols
        assert "cover_url" in cols
        assert "year" in cols
        with sqlite3.connect(db_path) as conn:
            author = conn.execute("SELECT author FROM downloads WHERE md5 = 'p1'").fetchone()[0]
        assert author == "A"

        # Second run adds nothing further.
        assert run_migrations(db_path) == 0


# ---------------------------------------------------------------------------
# Tests: transactional integrity on failure
# ---------------------------------------------------------------------------


class TestFailingMigrationRollback:
    def test_should_rollback_failed_migration_and_not_record_version(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "fail.db")
        run_migrations(db_path)
        version_before = get_current_version(db_path)
        fail_version = version_before + 1

        def _boom(cursor: sqlite3.Cursor) -> None:
            cursor.execute("CREATE TABLE IF NOT EXISTS _migration_probe (id INTEGER PRIMARY KEY)")
            cursor.execute("INSERT INTO _migration_probe (id) VALUES (1)")
            raise RuntimeError("injected migration failure")

        migrations_mod._MIGRATIONS[fail_version] = migrations_mod.MigrationEntry(
            version=fail_version,
            description="Injected failing migration",
            fn=_boom,
        )
        try:
            with pytest.raises(SchemaMigrationError, match="injected migration failure") as exc_info:
                run_migrations(db_path)

            assert exc_info.value.db_path == db_path
            assert exc_info.value.version == fail_version
            assert isinstance(exc_info.value.__cause__, RuntimeError)
            assert get_current_version(db_path) == version_before
            assert not _table_exists(db_path, "_migration_probe")
        finally:
            migrations_mod._MIGRATIONS.pop(fail_version, None)

    def test_should_wrap_failure_with_db_path_and_version_in_message(self, tmp_path: Path) -> None:
        db_path = str(tmp_path / "named_fail.db")
        run_migrations(db_path)
        fail_version = get_current_version(db_path) + 1

        def _boom(cursor: sqlite3.Cursor) -> None:
            raise RuntimeError("boom")

        migrations_mod._MIGRATIONS[fail_version] = migrations_mod.MigrationEntry(
            version=fail_version,
            description="Named fail",
            fn=_boom,
        )
        try:
            with pytest.raises(SchemaMigrationError) as exc_info:
                run_migrations(db_path)
            msg = str(exc_info.value)
            assert db_path in msg
            assert str(fail_version) in msg
            assert "schema" in msg.lower() or "migration" in msg.lower()
        finally:
            migrations_mod._MIGRATIONS.pop(fail_version, None)


# ---------------------------------------------------------------------------
# Tests: production entry wiring (CLI + bridge)
# ---------------------------------------------------------------------------


class TestProductionWiring:
    def test_cli_dispatch_calls_run_migrations_before_db_use(self, tmp_path: Path) -> None:
        from src.cli import main

        history = str(tmp_path / "cli_history.db")
        cfg = {"out_dir": "downloads", "proxies": [], "concurrency": 2, "history_db": history}
        order: list[str] = []

        with (
            patch("sys.argv", ["cli", "history", "-n", "5"]),
            patch("src.cli.get_config", return_value=cfg),
            patch("src.cli.setup_logging", return_value=MagicMock()),
            patch(
                "src.cli.print_download_history",
                side_effect=lambda *a, **k: order.append("history"),
            ),
            patch(
                "src.cli.run_migrations",
                side_effect=lambda *a, **k: order.append("migrate") or 0,
            ) as mock_mig,
        ):
            main()

        mock_mig.assert_called_once_with(history)
        assert order == ["migrate", "history"]

    def test_cli_resolves_default_history_db_when_config_unset(self) -> None:
        from src.cli import main

        cfg = {"out_dir": "downloads", "proxies": [], "concurrency": 2, "history_db": None}
        with (
            patch("sys.argv", ["cli", "diagnose"]),
            patch("src.cli.get_config", return_value=cfg),
            patch("src.cli.setup_logging", return_value=MagicMock()),
            patch("src.cli.run_diagnostics"),
            patch("src.cli.get_default_history_db_path", return_value="/tmp/default_hist.db"),
            patch("src.cli.run_migrations") as mock_mig,
        ):
            main()

        mock_mig.assert_called_once_with("/tmp/default_hist.db")

    def test_cli_halts_on_migration_failure_without_running_history(self, tmp_path: Path) -> None:
        from src.cli import main

        history = str(tmp_path / "cli_halt.db")
        cfg = {"out_dir": "downloads", "proxies": [], "concurrency": 2, "history_db": history}
        err = SchemaMigrationError(
            f"Database schema migration failed for {history} at version 99: boom",
            db_path=history,
            version=99,
        )

        with (
            patch("sys.argv", ["cli", "history", "-n", "5"]),
            patch("src.cli.get_config", return_value=cfg),
            patch("src.cli.setup_logging", return_value=MagicMock()),
            patch("src.cli.print_download_history") as mock_hist,
            patch("src.cli.run_migrations", side_effect=err),
            patch("src.cli.console") as mock_console,
            pytest.raises(SystemExit) as exc_info,
        ):
            main()

        assert exc_info.value.code == 1
        mock_hist.assert_not_called()
        printed = " ".join(str(c) for c in mock_console.print.call_args_list)
        assert "HALT" in printed
        assert "schema" in printed.lower() or "migration" in printed.lower()

    def test_bridge_main_runs_migrations_before_orphan_cleanup(self, tmp_path: Path) -> None:
        import importlib
        import sys

        bridge_dir = Path(__file__).resolve().parents[1] / "electron-app" / "python"
        if str(bridge_dir) not in sys.path:
            sys.path.insert(0, str(bridge_dir))

        # Import (or re-import) the bridge module under a stable name.
        if "bridge" in sys.modules:
            bridge = importlib.reload(sys.modules["bridge"])
        else:
            bridge = importlib.import_module("bridge")

        history = str(tmp_path / "bridge_history.db")
        empty_stdin = MagicMock()
        empty_stdin.__iter__ = MagicMock(return_value=iter([]))

        call_order: list[str] = []

        def _mig(path: str) -> int:
            call_order.append(f"migrate:{path}")
            return 0

        def _cleanup(**kwargs) -> int:  # noqa: ANN003
            call_order.append("cleanup")
            return 0

        with (
            patch.object(bridge, "bridge_handlers", create=True),
            patch("bridge_handlers.register_handlers"),
            patch("src.config_manager.get_config", return_value={"history_db": history, "out_dir": str(tmp_path)}),
            patch("src.config_manager.get_default_history_db_path", return_value=history),
            patch("src.migrations.run_migrations", side_effect=_mig) as mock_mig,
            patch("src.download_history.cleanup_orphaned_downloads", side_effect=_cleanup),
            patch("audiobook_queue.resweep", create=True),
            patch.object(sys, "stdin", MagicMock(buffer=empty_stdin)),
        ):
            # bridge_handlers is imported inside main — patch both import sites.
            with patch.dict(
                "sys.modules",
                {
                    "bridge_handlers": MagicMock(register_handlers=MagicMock()),
                    "audiobook_queue": MagicMock(resweep=MagicMock()),
                },
            ):
                bridge.main()

        mock_mig.assert_called_once_with(history)
        assert call_order[0].startswith("migrate:")
        assert "cleanup" in call_order
        assert call_order.index("cleanup") > 0

    def test_bridge_main_exits_on_migration_failure_before_cleanup(self, tmp_path: Path) -> None:
        import importlib
        import sys

        bridge_dir = Path(__file__).resolve().parents[1] / "electron-app" / "python"
        if str(bridge_dir) not in sys.path:
            sys.path.insert(0, str(bridge_dir))

        if "bridge" in sys.modules:
            bridge = importlib.reload(sys.modules["bridge"])
        else:
            bridge = importlib.import_module("bridge")

        history = str(tmp_path / "bridge_fail.db")
        err = SchemaMigrationError(
            f"Database schema migration failed for {history} at version 2: boom",
            db_path=history,
            version=2,
        )
        empty_stdin = MagicMock()
        empty_stdin.__iter__ = MagicMock(return_value=iter([]))

        with (
            patch("src.config_manager.get_config", return_value={"history_db": history, "out_dir": str(tmp_path)}),
            patch("src.config_manager.get_default_history_db_path", return_value=history),
            patch("src.migrations.run_migrations", side_effect=err),
            patch("src.download_history.cleanup_orphaned_downloads") as mock_cleanup,
            patch.object(sys, "stdin", MagicMock(buffer=empty_stdin)),
            patch.object(bridge.logger, "critical") as mock_critical,
            patch.object(bridge.logger, "info") as mock_info,
            patch.dict(
                "sys.modules",
                {
                    "bridge_handlers": MagicMock(register_handlers=MagicMock()),
                    "audiobook_queue": MagicMock(resweep=MagicMock()),
                },
            ),
            pytest.raises(SystemExit) as exc_info,
        ):
            bridge.main()

        assert exc_info.value.code == 1
        mock_cleanup.assert_not_called()
        mock_critical.assert_called()
        ready_calls = [c for c in mock_info.call_args_list if c.args and "Bridge ready" in str(c.args[0])]
        assert ready_calls == []


# ---------------------------------------------------------------------------
# Tests: registered migrations sanity
# ---------------------------------------------------------------------------


class TestMigrationRegistry:
    def test_should_have_sequential_versions(self) -> None:
        migs = get_registered_migrations()
        versions = [m.version for m in migs]
        assert versions == list(range(1, len(migs) + 1))

    def test_should_have_non_empty_descriptions(self) -> None:
        for m in get_registered_migrations():
            assert m.description, f"Migration v{m.version} has empty description"

    def test_should_end_at_version_covering_audiobooks(self) -> None:
        # Canonical set is schema_version + downloads + audiobooks.
        assert get_registered_migrations()[-1].version >= 3
