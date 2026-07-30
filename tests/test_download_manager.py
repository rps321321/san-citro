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
