"""Tests for electron-app/python/audiobook_queue.py.

The queue's worker pool and resweep are exercised with everything below them
mocked — no real extraction, no real DB, no real bridge. ``_process_one`` is
called directly (deterministic) rather than racing a daemon thread.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

if TYPE_CHECKING:
    import pytest

BRIDGE_DIR = Path(__file__).resolve().parents[1] / "electron-app" / "python"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

audiobook_queue = importlib.import_module("audiobook_queue")

_MD5 = "a" * 32


# ---------------------------------------------------------------------------
# _compute_pool_size
# ---------------------------------------------------------------------------
class TestComputePoolSize:
    def test_should_return_one_on_hdd(self) -> None:
        with (
            patch.object(audiobook_queue, "_drive_media_type", return_value="HDD"),
            patch("os.cpu_count", return_value=16),
        ):
            assert audiobook_queue._compute_pool_size("D:/out") == 1

    def test_should_return_one_on_unknown(self) -> None:
        with (
            patch.object(audiobook_queue, "_drive_media_type", return_value="UNKNOWN"),
            patch("os.cpu_count", return_value=16),
        ):
            assert audiobook_queue._compute_pool_size("D:/out") == 1

    def test_should_return_half_cores_on_ssd(self) -> None:
        with (
            patch.object(audiobook_queue, "_drive_media_type", return_value="SSD"),
            patch("os.cpu_count", return_value=4),
        ):
            assert audiobook_queue._compute_pool_size("C:/out") == 2

    def test_should_cap_pool_at_three_on_ssd(self) -> None:
        with (
            patch.object(audiobook_queue, "_drive_media_type", return_value="SSD"),
            patch("os.cpu_count", return_value=32),
        ):
            assert audiobook_queue._compute_pool_size("C:/out") == 3

    def test_should_floor_pool_at_one_on_ssd_single_core(self) -> None:
        with (
            patch.object(audiobook_queue, "_drive_media_type", return_value="SSD"),
            patch("os.cpu_count", return_value=1),
        ):
            assert audiobook_queue._compute_pool_size("C:/out") == 1

    def test_should_floor_at_one_when_cpu_count_is_none(self) -> None:
        with (
            patch.object(audiobook_queue, "_drive_media_type", return_value="SSD"),
            patch("os.cpu_count", return_value=None),
        ):
            assert audiobook_queue._compute_pool_size("C:/out") == 1


# ---------------------------------------------------------------------------
# _drive_media_type (its try/except default — no real PowerShell dependency)
# ---------------------------------------------------------------------------
class TestDriveMediaType:
    def test_should_return_unknown_when_subprocess_raises(self) -> None:
        with patch("subprocess.run", side_effect=OSError("no powershell")):
            assert audiobook_queue._drive_media_type("C:/out") == "UNKNOWN"

    def test_should_return_unknown_on_nonzero_exit(self) -> None:
        result = MagicMock(returncode=1, stdout="")
        with patch("subprocess.run", return_value=result):
            assert audiobook_queue._drive_media_type("C:/out") == "UNKNOWN"

    def test_should_parse_ssd_from_output(self) -> None:
        result = MagicMock(returncode=0, stdout="SSD\n")
        with patch("subprocess.run", return_value=result):
            assert audiobook_queue._drive_media_type("C:/out") == "SSD"

    def test_should_parse_hdd_from_output(self) -> None:
        result = MagicMock(returncode=0, stdout="HDD\n")
        with patch("subprocess.run", return_value=result):
            assert audiobook_queue._drive_media_type("C:/out") == "HDD"

    def test_should_return_unknown_for_unrecognized_media(self) -> None:
        result = MagicMock(returncode=0, stdout="Unspecified\n")
        with patch("subprocess.run", return_value=result):
            assert audiobook_queue._drive_media_type("C:/out") == "UNKNOWN"


# ---------------------------------------------------------------------------
# worker body (_process_one): processes, stamps media_type, emits the event
# ---------------------------------------------------------------------------
class TestProcessOne:
    def test_should_process_set_audiobook_media_type_and_emit(self) -> None:
        send_event = MagicMock()
        with (
            patch.object(audiobook_queue.audiobook_processor, "process_audiobook", return_value="ready") as proc,
            patch.object(audiobook_queue.audiobook_processor, "classify", return_value="audiobook"),
            patch.object(audiobook_queue, "set_media_type") as set_mt,
            patch.object(audiobook_queue, "_get_send_event", return_value=send_event),
        ):
            audiobook_queue._process_one(_MD5, "/out/x.zip", "/out")

        proc.assert_called_once_with(_MD5, "/out/x.zip", "/out")
        set_mt.assert_called_once_with(md5=_MD5, media_type="audiobook")
        send_event.assert_called_once_with("audiobook_status", {"md5": _MD5, "status": "ready"})

    def test_should_set_book_media_type_when_classified_as_book(self) -> None:
        send_event = MagicMock()
        with (
            patch.object(audiobook_queue.audiobook_processor, "process_audiobook", return_value="skipped"),
            patch.object(audiobook_queue.audiobook_processor, "classify", return_value="book"),
            patch.object(audiobook_queue, "set_media_type") as set_mt,
            patch.object(audiobook_queue, "_get_send_event", return_value=send_event),
        ):
            audiobook_queue._process_one(_MD5, "/out/x.zip", "/out")

        set_mt.assert_called_once_with(md5=_MD5, media_type="book")
        send_event.assert_called_once_with("audiobook_status", {"md5": _MD5, "status": "skipped"})

    def test_should_not_raise_when_event_emit_fails(self) -> None:
        with (
            patch.object(audiobook_queue.audiobook_processor, "process_audiobook", return_value="error"),
            patch.object(audiobook_queue.audiobook_processor, "classify", return_value="audiobook"),
            patch.object(audiobook_queue, "set_media_type"),
            patch.object(audiobook_queue, "_get_send_event", side_effect=RuntimeError("no bridge")),
        ):
            # Must swallow the emit failure rather than propagate.
            audiobook_queue._process_one(_MD5, "/out/x.zip", "/out")


# ---------------------------------------------------------------------------
# worker loop: a crash in one job never kills the worker
# ---------------------------------------------------------------------------
class TestWorkerLoop:
    def test_should_survive_a_crashing_job(self) -> None:
        calls: list[str] = []

        def fake_process(md5: str, file_path: str, out_dir: str) -> None:
            calls.append(md5)
            if md5 == "boom":
                raise RuntimeError("processing blew up")

        # Run the loop on a thread, feed it a crashing job then a good one, and
        # assert the second job still ran (the worker did not die).
        import threading

        with patch.object(audiobook_queue, "_process_one", side_effect=fake_process):
            audiobook_queue._job_queue.put(("boom", "/o/b.zip", "/o"))
            audiobook_queue._job_queue.put(("ok", "/o/g.zip", "/o"))
            worker = threading.Thread(target=audiobook_queue._worker_loop, daemon=True)
            worker.start()
            audiobook_queue._job_queue.join()

        assert calls == ["boom", "ok"]


# ---------------------------------------------------------------------------
# resweep
# ---------------------------------------------------------------------------
class TestResweep:
    def test_should_re_enqueue_pending_with_existing_archive(self) -> None:
        rows = [{"md5": _MD5, "status": "pending"}]
        with (
            patch.object(audiobook_queue.audiobook_db, "reset_stuck_audiobooks"),
            patch.object(audiobook_queue.audiobook_processor, "sweep_stale_tmp"),
            patch.object(audiobook_queue.audiobook_db, "list_audiobooks", return_value=rows),
            patch.object(audiobook_queue, "get_completed_download", return_value={"filename": "book.zip"}),
            patch("os.path.isfile", return_value=True),
            patch.object(audiobook_queue, "enqueue") as enqueue,
            patch.object(audiobook_queue.audiobook_db, "set_audiobook_status") as set_status,
        ):
            audiobook_queue.resweep("/out")

        enqueue.assert_called_once()
        args = enqueue.call_args.args
        assert args[0] == _MD5
        assert args[1].replace("\\", "/") == "/out/book.zip"
        assert args[2] == "/out"
        set_status.assert_not_called()

    def test_should_error_pending_when_archive_missing_on_disk(self) -> None:
        rows = [{"md5": _MD5, "status": "pending"}]
        with (
            patch.object(audiobook_queue.audiobook_db, "reset_stuck_audiobooks"),
            patch.object(audiobook_queue.audiobook_processor, "sweep_stale_tmp"),
            patch.object(audiobook_queue.audiobook_db, "list_audiobooks", return_value=rows),
            patch.object(audiobook_queue, "get_completed_download", return_value={"filename": "gone.zip"}),
            patch("os.path.isfile", return_value=False),
            patch.object(audiobook_queue, "enqueue") as enqueue,
            patch.object(audiobook_queue.audiobook_db, "set_audiobook_status") as set_status,
        ):
            audiobook_queue.resweep("/out")

        enqueue.assert_not_called()
        set_status.assert_called_once_with(md5=_MD5, status="error", error_message="source archive missing")

    def test_should_error_pending_when_no_download_record(self) -> None:
        rows = [{"md5": _MD5, "status": "pending"}]
        with (
            patch.object(audiobook_queue.audiobook_db, "reset_stuck_audiobooks"),
            patch.object(audiobook_queue.audiobook_processor, "sweep_stale_tmp"),
            patch.object(audiobook_queue.audiobook_db, "list_audiobooks", return_value=rows),
            patch.object(audiobook_queue, "get_completed_download", return_value=None),
            patch.object(audiobook_queue, "enqueue") as enqueue,
            patch.object(audiobook_queue.audiobook_db, "set_audiobook_status") as set_status,
        ):
            audiobook_queue.resweep("/out")

        enqueue.assert_not_called()
        set_status.assert_called_once_with(md5=_MD5, status="error", error_message="source archive missing")

    def test_should_ignore_non_pending_rows(self) -> None:
        rows = [
            {"md5": "r" * 32, "status": "ready"},
            {"md5": "e" * 32, "status": "error"},
        ]
        with (
            patch.object(audiobook_queue.audiobook_db, "reset_stuck_audiobooks") as reset,
            patch.object(audiobook_queue.audiobook_processor, "sweep_stale_tmp") as sweep,
            patch.object(audiobook_queue.audiobook_db, "list_audiobooks", return_value=rows),
            patch.object(audiobook_queue, "get_completed_download") as get_dl,
            patch.object(audiobook_queue, "enqueue") as enqueue,
            patch.object(audiobook_queue.audiobook_db, "set_audiobook_status") as set_status,
        ):
            audiobook_queue.resweep("/out")

        reset.assert_called_once()
        sweep.assert_called_once_with("/out")
        get_dl.assert_not_called()
        enqueue.assert_not_called()
        set_status.assert_not_called()


# ---------------------------------------------------------------------------
# enqueue / start idempotency
# ---------------------------------------------------------------------------
class TestStartAndEnqueue:
    def test_start_should_be_idempotent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Reset the module-level start guard around this test.
        monkeypatch.setattr(audiobook_queue, "_pool_started", False)
        spawned: list[object] = []

        real_thread = audiobook_queue.threading.Thread

        def counting_thread(*args: object, **kwargs: object) -> object:
            t = real_thread(*args, **kwargs)
            spawned.append(t)
            return t

        with (
            patch.object(audiobook_queue, "_compute_pool_size", return_value=2),
            patch.object(audiobook_queue.threading, "Thread", side_effect=counting_thread),
        ):
            audiobook_queue.start("/out")
            audiobook_queue.start("/out")  # second call must be a no-op

        assert len(spawned) == 2  # only the first start spawned workers

    def test_enqueue_should_start_pool_and_put_job(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with patch.object(audiobook_queue, "start") as start, patch.object(audiobook_queue._job_queue, "put") as put:
            audiobook_queue.enqueue(_MD5, "/out/x.zip", "/out")

        start.assert_called_once_with("/out")
        put.assert_called_once_with((_MD5, "/out/x.zip", "/out"))
