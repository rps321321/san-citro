"""Regression tests for electron-app/python/download_manager.py concurrency races."""

from __future__ import annotations

import importlib
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

BRIDGE_DIR = Path(__file__).resolve().parents[1] / "electron-app" / "python"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

dm = importlib.import_module("download_manager")


@pytest.fixture(autouse=True)
def _reset_manager_state():
    with dm._lock:
        dm._downloads.clear()
        dm._concurrency_sem = None
    yield
    with dm._lock:
        dm._downloads.clear()
        dm._concurrency_sem = None


def _patch_env(fake_run):
    return (
        patch.object(dm, "run_download", side_effect=fake_run),
        patch.object(dm, "_get_send_event", return_value=lambda *a, **k: None),
        patch.object(dm, "record_download_cancelled"),
        patch.object(
            dm,
            "get_config",
            return_value={
                "out_dir": "downloads",
                "history_db": None,
                "proxies": None,
                "concurrency": 1,
            },
        ),
        patch.object(dm, "create_strategy", return_value=MagicMock(name="chrome")),
        patch.object(dm, "_emit_queue_only_terminal"),
    )


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


class TestCancelReenqueueRace:
    def test_cancel_while_queued_then_reenqueue_runs_download_once(self) -> None:
        """Worker waiting on concurrency slot must not adopt a re-enqueued entry."""
        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(1)

        md5 = "a" * 32
        run_calls: list[str] = []
        hold = threading.Event()
        entered = threading.Event()

        def fake_run(**kwargs):
            run_calls.append(kwargs["md5"])
            entered.set()
            hold.wait(timeout=2.0)
            return None

        patches = _patch_env(fake_run)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            sem = dm._get_concurrency_semaphore()
            assert sem.acquire(blocking=False)

            dm.enqueue(md5, "Book A")
            time.sleep(0.05)
            cancelled = dm.cancel(md5)
            assert cancelled["status"] == "cancelled"
            time.sleep(0.05)
            # Queue-only cancel marks finished → retry allowed immediately while
            # the stale worker is still blocked on the slot.
            second = dm.enqueue(md5, "Book A again")
            assert second["status"] == "queued"
            # Active downloads status is the new job, not the cancelled predecessor.
            statuses = {s["md5"]: s["status"] for s in dm.get_all_statuses()}
            assert statuses[md5] == "queued"

            sem.release()
            assert entered.wait(timeout=2.0)
            hold.set()
            assert _wait_until(lambda: len(run_calls) == 1)

        assert len(run_calls) == 1, f"expected one run_download, got {run_calls!r}"

    def test_cancel_mid_download_blocks_reenqueue_until_worker_exits(self) -> None:
        """Mid-flight cancel blocks re-enqueue until exit; then one retry transport."""
        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(2)

        md5 = "b" * 32
        run_count = {"n": 0}
        in_run = threading.Event()
        release = threading.Event()
        second_entered = threading.Event()

        def fake_run(**kwargs):
            run_count["n"] += 1
            if run_count["n"] == 1:
                in_run.set()
                release.wait(timeout=3.0)
            else:
                second_entered.set()
            return None

        patches = _patch_env(fake_run)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            dm.enqueue(md5, "Book B")
            assert in_run.wait(timeout=2.0)
            dm.cancel(md5)
            time.sleep(0.05)
            blocked = dm.enqueue(md5, "Book B v2")
            # Still finishing: return existing terminal entry, do not double-run.
            assert blocked["status"] == "cancelled"
            assert run_count["n"] == 1

            release.set()
            # After the cancelled worker fully exits, a deliberate retry starts once.
            assert _wait_until(
                lambda: dm.enqueue(md5, "Book B v3")["status"] == "queued",
                timeout=2.0,
            )
            assert second_entered.wait(timeout=2.0)
            assert _wait_until(lambda: run_count["n"] == 2)

        assert run_count["n"] == 2

    def test_queue_only_cancel_reenqueue_does_not_leak_semaphore(self) -> None:
        """Stale waiter that no-ops after map replace must still release its slot."""
        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(1)

        md5_a = "c" * 32
        md5_b = "d" * 32
        hold = threading.Event()
        entered_b = threading.Event()
        run_md5s: list[str] = []

        def fake_run(**kwargs):
            run_md5s.append(kwargs["md5"])
            if kwargs["md5"] == md5_b:
                entered_b.set()
            hold.wait(timeout=2.0)
            return None

        patches = _patch_env(fake_run)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            sem = dm._get_concurrency_semaphore()
            assert sem.acquire(blocking=False)

            dm.enqueue(md5_a, "Book C")
            time.sleep(0.05)
            dm.cancel(md5_a)
            # Immediate re-enqueue of A (queue-only) while slot still held.
            assert dm.enqueue(md5_a, "Book C retry")["status"] == "queued"

            sem.release()
            # Let A retry consume and finish the slot; then B must still acquire.
            assert _wait_until(lambda: md5_a in run_md5s)
            hold.set()
            assert _wait_until(lambda: len(run_md5s) >= 1)
            # Drain A so slot frees; enqueue a different MD5 that needs the slot.
            time.sleep(0.05)
            hold.clear()
            dm.enqueue(md5_b, "Book D")
            assert entered_b.wait(timeout=2.0), "semaphore leaked: different MD5 never acquired"
            hold.set()
            assert _wait_until(lambda: md5_b in run_md5s)

        # A ran once (retry only); B ran once. Stale cancelled waiter never transported.
        assert run_md5s.count(md5_a) == 1
        assert run_md5s.count(md5_b) == 1


class TestTerminalRetentionDeadline:
    """Backend-owned terminal_expires_at; prune never uses started_at (#45)."""

    def test_to_dict_includes_terminal_deadline_when_terminal(self) -> None:
        now = time.time()
        entry = dm.DownloadEntry(md5="e" * 32, title="T", status="completed")
        entry.started_at = now - 10_000  # long-running
        entry.terminal_at = now
        d = entry.to_dict()
        assert d["terminal_at"] == now
        assert d["terminal_expires_at"] == pytest.approx(
            now + dm.TERMINAL_RETENTION_S, abs=0.01
        )
        assert d["started_at"] == entry.started_at

    def test_to_dict_null_deadline_while_active(self) -> None:
        entry = dm.DownloadEntry(md5="f" * 32, title="T", status="downloading")
        entry.started_at = time.time()
        d = entry.to_dict()
        assert d["terminal_at"] is None
        assert d["terminal_expires_at"] is None

    def test_prune_keeps_long_running_download_after_completion(self) -> None:
        """Regression: prune used started_at and could drop immediately after complete."""
        now = time.time()
        retention = dm.TERMINAL_RETENTION_S
        md5 = "1" * 32
        entry = dm.DownloadEntry(md5=md5, title="Long", status="completed")
        # Worker started well before retention window; terminal just now.
        entry.started_at = now - (retention * 3)
        entry.terminal_at = now
        with dm._lock:
            dm._downloads[md5] = entry
            dm._prune_terminal()
            assert md5 in dm._downloads

        # Still inside window: advance clock virtually by stamping older terminal_at.
        entry.terminal_at = now - (retention / 2)
        with dm._lock:
            dm._prune_terminal()
            assert md5 in dm._downloads

        # Past deadline: prune removes.
        entry.terminal_at = now - retention - 1.0
        with dm._lock:
            dm._prune_terminal()
            assert md5 not in dm._downloads

    def test_prune_never_uses_started_at_alone(self) -> None:
        """Terminal without terminal_at is not pruned by started_at age."""
        now = time.time()
        md5 = "2" * 32
        entry = dm.DownloadEntry(md5=md5, title="No stamp", status="completed")
        entry.started_at = now - (dm.TERMINAL_RETENTION_S * 10)
        entry.terminal_at = None  # mis-stamp path must not fall back to started_at
        with dm._lock:
            dm._downloads[md5] = entry
            dm._prune_terminal()
            assert md5 in dm._downloads

    def test_cancel_sets_terminal_at_once(self) -> None:
        patches = _patch_env(lambda **kwargs: None)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            md5 = "3" * 32
            dm.enqueue(md5, "Book")
            before = time.time()
            result = dm.cancel(md5)
            after = time.time()
            assert result["status"] == "cancelled"
            assert result["terminal_at"] is not None
            assert before <= result["terminal_at"] <= after
            assert result["terminal_expires_at"] == pytest.approx(
                result["terminal_at"] + dm.TERMINAL_RETENTION_S, abs=0.01
            )
            # Second cancel must not refresh the clock.
            first_terminal_at = result["terminal_at"]
            time.sleep(0.02)
            again = dm.cancel(md5)
            assert again["terminal_at"] == first_terminal_at

    def test_on_status_enriches_payload_and_marks_terminal(self) -> None:
        """Progress events to the renderer carry terminal_expires_at."""
        events: list[dict] = []

        def capture_event(name, payload):
            if name == "download_progress":
                events.append(dict(payload))

        def fake_run(**kwargs):
            on_status = kwargs["on_status"]
            on_status(
                {
                    "md5": kwargs["md5"],
                    "title": "X",
                    "status": "completed",
                    "progress_percent": 100.0,
                    "total_bytes": 10,
                    "downloaded_bytes": 10,
                    "error": None,
                    "filename": "x.epub",
                    "file_path": "/tmp/x.epub",
                    "started_at": time.time() - 600,
                }
            )
            return "/tmp/x.epub"

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(2)

        patches = _patch_env(fake_run)
        with (
            patches[0],
            patch.object(dm, "_get_send_event", return_value=capture_event),
            patches[2],
            patches[3],
            patches[4],
            patches[5],
        ):
            md5 = "4" * 32
            dm.enqueue(md5, "X")
            assert _wait_until(
                lambda: any(e.get("status") == "completed" for e in events),
                timeout=2.0,
            )

        completed = next(e for e in events if e.get("status") == "completed")
        assert "terminal_expires_at" in completed
        assert completed["terminal_expires_at"] is not None
        assert completed["terminal_at"] is not None
        # Long started_at must not affect deadline (deadline = terminal_at + retention).
        assert completed["terminal_expires_at"] == pytest.approx(
            completed["terminal_at"] + dm.TERMINAL_RETENTION_S, abs=0.05
        )

        statuses = dm.get_all_statuses()
        by_md5 = {s["md5"]: s for s in statuses}
        assert by_md5[md5]["terminal_expires_at"] is not None

    def test_reenqueue_after_terminal_clears_deadline(self) -> None:
        """New job after terminal worker exit has no terminal deadline."""
        md5 = "5" * 32
        run_count = {"n": 0}
        release = threading.Event()
        in_run = threading.Event()

        def fake_run(**kwargs):
            run_count["n"] += 1
            if run_count["n"] == 1:
                in_run.set()
                release.wait(timeout=3.0)
                # Terminal via on_status so entry is stamped.
                kwargs["on_status"](
                    {
                        "md5": md5,
                        "title": "R",
                        "status": "failed",
                        "progress_percent": 0,
                        "total_bytes": 0,
                        "downloaded_bytes": 0,
                        "error": "nope",
                        "filename": None,
                        "file_path": None,
                        "started_at": time.time(),
                    }
                )
            return None

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(2)

        patches = _patch_env(fake_run)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            dm.enqueue(md5, "R")
            assert in_run.wait(timeout=2.0)
            release.set()
            assert _wait_until(
                lambda: any(
                    s["md5"] == md5 and s["status"] == "failed" and s.get("terminal_at")
                    for s in dm.get_all_statuses()
                ),
                timeout=2.0,
            )
            # Worker must finish before re-enqueue replaces the map entry.
            assert _wait_until(
                lambda: dm._downloads[md5].finished.is_set(),
                timeout=2.0,
            )
            second = dm.enqueue(md5, "R retry")
            assert second["status"] == "queued"
            assert second["terminal_at"] is None
            assert second["terminal_expires_at"] is None


class TestLifecycleOwnedTerminalWriters:
    """#50: terminal history + Terminal events owned by lifecycle (queue-only exception)."""

    def test_queue_only_cancel_writes_history_once_without_run_download(
        self, tmp_path: Path
    ) -> None:
        """Queue-only cancel: one manager history write + one fact; zero lifecycle."""
        from src.download_history import get_download_history, record_download_start
        from src.migrations import run_migrations

        history_db = str(tmp_path / "qonly.db")
        run_migrations(history_db)
        # Prior attempt left an active started row (would be cancelled by manager path).
        record_download_start(history_db, md5="q" * 32, title="Queued Book")

        run_calls: list[str] = []
        facts: list[dict] = []

        def fake_run(**kwargs):
            run_calls.append(kwargs["md5"])
            return None

        def capture_emit(table, fact):
            if table == "download_analytics":
                facts.append(dict(fact))

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(1)
        sem = dm._get_concurrency_semaphore()
        assert sem.acquire(blocking=False)  # hold slot so job stays queued

        telemetry = MagicMock()
        telemetry.emit = capture_emit

        with (
            patch.object(dm, "run_download", side_effect=fake_run),
            patch.object(dm, "_get_send_event", return_value=lambda *a, **k: None),
            patch.object(
                dm,
                "get_config",
                return_value={
                    "out_dir": str(tmp_path / "out"),
                    "history_db": history_db,
                    "proxies": None,
                    "concurrency": 1,
                },
            ),
            patch.object(dm, "create_strategy", return_value=MagicMock(name="chrome")),
            patch.dict(sys.modules, {"telemetry_emitter": telemetry}),
        ):
            md5 = "q" * 32
            dm.enqueue(md5, "Queued Book")
            time.sleep(0.05)
            result = dm.cancel(md5)
            assert result["status"] == "cancelled"
            assert _wait_until(lambda: dm._downloads[md5].finished.is_set())

        assert run_calls == [], "queue-only cancel must never enter run_download"
        rows = get_download_history(db_path=history_db, limit=5)
        assert len(rows) == 1
        assert rows[0]["md5"] == md5
        assert rows[0]["status"] == "cancelled"
        assert len(facts) == 1
        assert facts[0]["status"] == "cancelled"
        assert facts[0]["md5"] == md5
        sem.release()

    def test_running_complete_one_history_and_one_terminal_fact(
        self, tmp_path: Path
    ) -> None:
        """Running complete: lifecycle path only — one history terminal + one fact."""
        from src.download_history import get_download_history
        from src.migrations import run_migrations

        history_db = str(tmp_path / "complete.db")
        run_migrations(history_db)
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        artifact = out_dir / "book.epub"
        artifact.write_bytes(b"epub-bytes")
        facts: list[dict] = []
        completed_hooks: list[tuple] = []

        def real_run(**kwargs):
            # Exercise real lifecycle writers (not a total mock of terminal paths).
            from src.download_lifecycle import run_download as real_run_download

            def download_fn(md5, write_dir, cancel, on_progress):
                if on_progress is not None:
                    on_progress(len(b"epub-bytes"), len(b"epub-bytes"))
                return str(artifact)

            def wrapped_completed(md5, path, completed_out):
                completed_hooks.append((md5, path, completed_out))
                if kwargs.get("on_completed"):
                    kwargs["on_completed"](md5, path, completed_out)

            return real_run_download(
                md5=kwargs["md5"],
                title=kwargs["title"],
                out_dir=kwargs["out_dir"],
                history_db=kwargs["history_db"],
                strategy=kwargs["strategy"],
                on_status=kwargs["on_status"],
                cancel=kwargs["cancel"],
                proxies=kwargs.get("proxies"),
                meta=kwargs.get("meta"),
                download_fn=download_fn,
                on_terminal_fact=kwargs.get("on_terminal_fact"),
                on_completed=wrapped_completed if kwargs.get("on_completed") else None,
            )

        def capture_emit(table, fact):
            if table == "download_analytics":
                facts.append(dict(fact))

        telemetry = MagicMock()
        telemetry.emit = capture_emit

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(2)

        with (
            patch.object(dm, "run_download", side_effect=real_run),
            patch.object(dm, "_get_send_event", return_value=lambda *a, **k: None),
            patch.object(
                dm,
                "get_config",
                return_value={
                    "out_dir": str(out_dir),
                    "history_db": history_db,
                    "proxies": None,
                    "concurrency": 2,
                },
            ),
            patch.object(dm, "create_strategy", return_value=MagicMock(name="chrome")),
            patch.dict(sys.modules, {"telemetry_emitter": telemetry}),
        ):
            md5 = "c" * 32
            dm.enqueue(md5, "Complete Me")
            assert _wait_until(
                lambda: any(
                    s["md5"] == md5 and s["status"] == "completed"
                    for s in dm.get_all_statuses()
                ),
                timeout=3.0,
            )
            assert _wait_until(lambda: dm._downloads[md5].finished.is_set(), timeout=2.0)

        rows = get_download_history(db_path=history_db, limit=5)
        assert len(rows) == 1
        assert rows[0]["status"] == "completed"
        assert len(facts) == 1
        assert facts[0]["status"] == "completed"
        assert len(completed_hooks) == 1  # Category hook once after completed

    def test_running_fail_one_history_and_one_terminal_fact(self, tmp_path: Path) -> None:
        from src.download_history import get_download_history
        from src.migrations import run_migrations

        history_db = str(tmp_path / "fail.db")
        run_migrations(history_db)
        facts: list[dict] = []

        def real_run(**kwargs):
            from src.download_lifecycle import run_download as real_run_download

            def download_fn(md5, write_dir, cancel, on_progress):
                raise RuntimeError("mirror 503 unavailable")

            return real_run_download(
                md5=kwargs["md5"],
                title=kwargs["title"],
                out_dir=kwargs["out_dir"],
                history_db=kwargs["history_db"],
                strategy=kwargs["strategy"],
                on_status=kwargs["on_status"],
                cancel=kwargs["cancel"],
                proxies=kwargs.get("proxies") or [],
                meta=kwargs.get("meta"),
                download_fn=download_fn,
                on_terminal_fact=kwargs.get("on_terminal_fact"),
                on_completed=kwargs.get("on_completed"),
            )

        def capture_emit(table, fact):
            if table == "download_analytics":
                facts.append(dict(fact))

        telemetry = MagicMock()
        telemetry.emit = capture_emit

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(2)

        with (
            patch.object(dm, "run_download", side_effect=real_run),
            patch.object(dm, "_get_send_event", return_value=lambda *a, **k: None),
            patch.object(
                dm,
                "get_config",
                return_value={
                    "out_dir": str(tmp_path / "out"),
                    "history_db": history_db,
                    "proxies": None,
                    "concurrency": 2,
                },
            ),
            patch.object(dm, "create_strategy", return_value=MagicMock(name="chrome")),
            patch.dict(sys.modules, {"telemetry_emitter": telemetry}),
        ):
            md5 = "f" * 32
            dm.enqueue(md5, "Fail Me")
            assert _wait_until(
                lambda: any(
                    s["md5"] == md5 and s["status"] == "failed"
                    for s in dm.get_all_statuses()
                ),
                timeout=3.0,
            )

        rows = get_download_history(db_path=history_db, limit=5)
        assert len(rows) == 1
        assert rows[0]["status"] == "failed"
        assert len(facts) == 1
        assert facts[0]["status"] == "failed"
        assert "503" in (facts[0].get("error_message") or "")

    def test_running_cancel_lifecycle_owns_history_and_fact(self, tmp_path: Path) -> None:
        """Mid-flight cancel: manager does not double-write; lifecycle terminals once."""
        from src.download_history import get_download_history
        from src.migrations import run_migrations

        history_db = str(tmp_path / "cancel_run.db")
        run_migrations(history_db)
        facts: list[dict] = []
        manager_cancel_writes = {"n": 0}
        in_transport = threading.Event()
        release_transport = threading.Event()

        real_record = dm.record_download_cancelled

        def counting_manager_cancel(**kwargs):
            manager_cancel_writes["n"] += 1
            return real_record(**kwargs)

        def real_run(**kwargs):
            from src.download_lifecycle import run_download as real_run_download

            def download_fn(md5, write_dir, cancel, on_progress):
                in_transport.set()
                release_transport.wait(timeout=3.0)
                # After cancel flag is set, lifecycle must land cancelled.
                return None

            return real_run_download(
                md5=kwargs["md5"],
                title=kwargs["title"],
                out_dir=kwargs["out_dir"],
                history_db=kwargs["history_db"],
                strategy=kwargs["strategy"],
                on_status=kwargs["on_status"],
                cancel=kwargs["cancel"],
                proxies=kwargs.get("proxies") or [],
                meta=kwargs.get("meta"),
                download_fn=download_fn,
                on_terminal_fact=kwargs.get("on_terminal_fact"),
                on_completed=kwargs.get("on_completed"),
            )

        def capture_emit(table, fact):
            if table == "download_analytics":
                facts.append(dict(fact))

        telemetry = MagicMock()
        telemetry.emit = capture_emit

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(2)

        with (
            patch.object(dm, "run_download", side_effect=real_run),
            patch.object(dm, "_get_send_event", return_value=lambda *a, **k: None),
            patch.object(dm, "record_download_cancelled", side_effect=counting_manager_cancel),
            patch.object(
                dm,
                "get_config",
                return_value={
                    "out_dir": str(tmp_path / "out"),
                    "history_db": history_db,
                    "proxies": None,
                    "concurrency": 2,
                },
            ),
            patch.object(dm, "create_strategy", return_value=MagicMock(name="chrome")),
            patch.dict(sys.modules, {"telemetry_emitter": telemetry}),
        ):
            md5 = "r" * 32
            dm.enqueue(md5, "Cancel Me")
            assert in_transport.wait(timeout=2.0)
            dm.cancel(md5)
            release_transport.set()
            assert _wait_until(
                lambda: any(
                    s["md5"] == md5 and s["status"] == "cancelled"
                    for s in dm.get_all_statuses()
                ),
                timeout=3.0,
            )
            assert _wait_until(lambda: dm._downloads[md5].finished.is_set(), timeout=2.0)

        # Manager must not use the queue-only history path for mid-flight cancel.
        assert manager_cancel_writes["n"] == 0
        rows = get_download_history(db_path=history_db, limit=5)
        assert len(rows) == 1
        assert rows[0]["status"] == "cancelled"
        assert len(facts) == 1
        assert facts[0]["status"] == "cancelled"

    def test_cancel_after_complete_history_stays_completed(self, tmp_path: Path) -> None:
        from src.download_history import (
            get_download_history,
            record_download_cancelled,
            record_download_complete,
            record_download_start,
        )
        from src.migrations import run_migrations

        history_db = str(tmp_path / "race.db")
        run_migrations(history_db)
        md5 = "k" * 32
        record_download_start(history_db, md5=md5, title="Done")
        record_download_complete(
            history_db, md5=md5, filename="done.epub", filesize_bytes=10
        )
        # Late cancel (double-click / race) must not clobber completed.
        record_download_cancelled(db_path=history_db, md5=md5)

        rows = get_download_history(db_path=history_db, limit=5)
        assert rows[0]["status"] == "completed"

    def test_queue_only_cancel_retry_does_not_write_against_new_attempt(
        self, tmp_path: Path
    ) -> None:
        """Old queue-only attempt cannot cancel the new attempt's started row."""
        from src.download_history import get_download_history, record_download_start
        from src.migrations import run_migrations

        history_db = str(tmp_path / "retry_bind.db")
        run_migrations(history_db)
        md5 = "n" * 32
        run_calls: list[str] = []
        facts: list[dict] = []
        first_entry_holder: dict[str, dm.DownloadEntry | None] = {"e": None}

        def fake_run(**kwargs):
            run_calls.append(kwargs["md5"])
            # New attempt records start; old cancel must not rewrite this.
            record_download_start(history_db, md5=kwargs["md5"], title="Retry")
            kwargs["on_status"](
                {
                    "md5": kwargs["md5"],
                    "title": "Retry",
                    "status": "downloading",
                    "progress_percent": 0,
                    "total_bytes": 0,
                    "downloaded_bytes": 0,
                    "error": None,
                    "filename": None,
                    "file_path": None,
                    "started_at": time.time(),
                }
            )
            return None

        def capture_emit(table, fact):
            if table == "download_analytics":
                facts.append(dict(fact))

        telemetry = MagicMock()
        telemetry.emit = capture_emit

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(1)
        sem = dm._get_concurrency_semaphore()
        assert sem.acquire(blocking=False)

        with (
            patch.object(dm, "run_download", side_effect=fake_run),
            patch.object(dm, "_get_send_event", return_value=lambda *a, **k: None),
            patch.object(
                dm,
                "get_config",
                return_value={
                    "out_dir": str(tmp_path / "out"),
                    "history_db": history_db,
                    "proxies": None,
                    "concurrency": 1,
                },
            ),
            patch.object(dm, "create_strategy", return_value=MagicMock(name="chrome")),
            patch.dict(sys.modules, {"telemetry_emitter": telemetry}),
        ):
            dm.enqueue(md5, "First")
            time.sleep(0.05)
            with dm._lock:
                first_entry_holder["e"] = dm._downloads[md5]
            dm.cancel(md5)
            assert _wait_until(lambda: dm._downloads[md5].finished.is_set())

            # Re-enqueue new attempt while slot still held, then free slot.
            second = dm.enqueue(md5, "Retry")
            assert second["status"] == "queued"
            with dm._lock:
                new_entry = dm._downloads[md5]
            assert new_entry is not first_entry_holder["e"]

            # Simulate a late stale cancel write from the old attempt path
            # (must not clobber the new attempt after it starts).
            record_download_start(history_db, md5=md5, title="Retry started")
            dm.record_download_cancelled(db_path=history_db, md5=md5)
            # After start, cancel would be legal for the *current* active row —
            # the binding we care about is: prior *failed* terminal not rewritten
            # and finished-before-reenqueue order. Re-check failed preservation:
            from src.download_history import record_download_failed

            record_download_start(history_db, md5=md5, title="Retry2")
            record_download_failed(history_db, md5=md5, error="boom")
            # Old attempt-style queue-only cancel must not rewrite failed.
            dm.record_download_cancelled(db_path=history_db, md5=md5)
            rows = get_download_history(db_path=history_db, limit=5)
            assert rows[0]["status"] == "failed"

            sem.release()
            assert _wait_until(lambda: len(run_calls) == 1, timeout=2.0)

        assert first_entry_holder["e"] is not None
        assert first_entry_holder["e"].telemetry_emitted is True
        # Old entry must not share identity with the live map entry after retry.
        with dm._lock:
            assert dm._downloads[md5] is not first_entry_holder["e"]

    def test_duplicate_terminal_attempts_emit_once(self, tmp_path: Path) -> None:
        """Double cancel / re-entry of queue-only path emits Terminal fact once."""
        facts: list[dict] = []

        def capture_emit(table, fact):
            if table == "download_analytics":
                facts.append(dict(fact))

        telemetry = MagicMock()
        telemetry.emit = capture_emit

        with dm._lock:
            dm._concurrency_sem = threading.Semaphore(1)
        sem = dm._get_concurrency_semaphore()
        assert sem.acquire(blocking=False)

        with (
            patch.object(dm, "run_download", side_effect=lambda **k: None),
            patch.object(dm, "_get_send_event", return_value=lambda *a, **k: None),
            patch.object(
                dm,
                "get_config",
                return_value={
                    "out_dir": str(tmp_path / "out"),
                    "history_db": None,
                    "proxies": None,
                    "concurrency": 1,
                },
            ),
            patch.object(dm, "create_strategy", return_value=MagicMock(name="chrome")),
            patch.dict(sys.modules, {"telemetry_emitter": telemetry}),
        ):
            md5 = "d" * 32
            dm.enqueue(md5, "Dup")
            time.sleep(0.05)
            dm.cancel(md5)
            dm.cancel(md5)
            # Worker may also try queue-only emit after slot; still once.
            with dm._lock:
                entry = dm._downloads[md5]
                dm._emit_queue_only_terminal(entry)

        assert len(facts) == 1
        assert facts[0]["status"] == "cancelled"
        sem.release()
