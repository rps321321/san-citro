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
