"""Lifecycle-seam tests for src/download_lifecycle.py.

Fake transport + temp history DB (after migrations). Asserts observable
status sequences, history rows, progress sink, Metadata spine, and Terminal
event fact (capturing sink) — not private helpers.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from src.download_history import get_download_history
from src.download_lifecycle import (
    PUBLIC_STATUSES,
    TERMINAL_RETENTION_S,
    build_terminal_fact,
    normalize_download_status,
    run_download,
    strategy_label,
)
from src.download_strategy import ChromeStrategy, DirectHTTPStrategy
from src.migrations import run_migrations


@pytest.fixture()
def history_db(tmp_path: Path) -> str:
    db_path = str(tmp_path / "lifecycle_history.db")
    run_migrations(db_path)
    return db_path


@pytest.fixture()
def out_dir(tmp_path: Path) -> str:
    d = tmp_path / "downloads"
    d.mkdir()
    return str(d)


def _statuses(events: list[dict[str, Any]]) -> list[str]:
    return [e["status"] for e in events]


def _run(
    *,
    md5: str = "a" * 32,
    title: str = "Test Book",
    out_dir: str,
    history_db: str | None,
    cancel: threading.Event | None = None,
    meta: dict[str, Any] | None = None,
    download_fn=None,
    on_progress=None,
    on_terminal_fact=None,
    on_completed=None,
    strategy=None,
    proxies: list[str] | None = None,
    capture_terminal: bool = True,
) -> tuple[str | None, list[dict[str, Any]], list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []
    terminal_facts: list[dict[str, Any]] = []
    tok = cancel if cancel is not None else threading.Event()
    strat = strategy if strategy is not None else MagicMock(name="strategy")

    def on_status(payload: dict[str, Any]) -> None:
        events.append(dict(payload))

    sink = None
    if capture_terminal or on_terminal_fact is not None:

        def _capture_terminal(fact: dict[str, Any]) -> None:
            terminal_facts.append(dict(fact))
            if on_terminal_fact is not None:
                on_terminal_fact(fact)

        sink = _capture_terminal

    path = run_download(
        md5=md5,
        title=title,
        out_dir=out_dir,
        history_db=history_db,
        strategy=strat,
        on_status=on_status,
        cancel=tok,
        proxies=[] if proxies is None else proxies,
        meta=meta,
        on_progress=on_progress,
        download_fn=download_fn,
        on_terminal_fact=sink,
        on_completed=on_completed,
    )
    return path, events, terminal_facts


# Table: durable/public input → expected public (or passthrough) value.
# Keep aligned with web/src/lib/status.test.ts NORMALIZE_CASES.
_NORMALIZE_CASES: list[tuple[str, str]] = [
    ("queued", "queued"),
    ("downloading", "downloading"),
    ("completed", "completed"),
    ("failed", "failed"),
    ("cancelled", "cancelled"),
    ("started", "downloading"),
    ("interrupted", "interrupted"),  # history-only; not coerced to live public
    ("unknown", "unknown"),
    ("", ""),
    ("bogus-status", "bogus-status"),
]


class TestNormalizeDownloadStatus:
    """One backend seam for durable/history → public lifecycle vocabulary (#46)."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        _NORMALIZE_CASES,
        ids=[f"{r}->{e}" for r, e in _NORMALIZE_CASES],
    )
    def test_normalize_table(self, raw: str, expected: str) -> None:
        assert normalize_download_status(raw) == expected

    def test_public_statuses_are_identity(self) -> None:
        for status in PUBLIC_STATUSES:
            assert normalize_download_status(status) == status

    def test_public_alphabet_is_exactly_five(self) -> None:
        assert PUBLIC_STATUSES == frozenset({"queued", "downloading", "completed", "failed", "cancelled"})

    def test_started_is_not_public(self) -> None:
        assert "started" not in PUBLIC_STATUSES
        assert normalize_download_status("started") in PUBLIC_STATUSES

    def test_interrupted_stays_history_only(self) -> None:
        assert normalize_download_status("interrupted") == "interrupted"
        assert "interrupted" not in PUBLIC_STATUSES


class TestCancelBeforeStart:
    def test_cancel_before_start_emits_cancelled_once_and_no_completed(self, history_db: str, out_dir: str) -> None:
        cancel = threading.Event()
        cancel.set()

        called = {"n": 0}

        def download_fn(md5, out, cancel_ev, on_progress):
            called["n"] += 1
            return None

        path, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            cancel=cancel,
            download_fn=download_fn,
        )

        assert path is None
        assert called["n"] == 0  # transport never invoked
        assert _statuses(events) == ["cancelled"]
        assert "started" not in _statuses(events)
        assert "completed" not in _statuses(events)
        assert "failed" not in _statuses(events)

        # Cancel-before-start never inserts a start row; history must not show
        # completed/failed for this md5. Manager may write cancel for queue-only.
        rows = get_download_history(db_path=history_db, limit=5)
        assert all(r["status"] != "completed" and r["status"] != "failed" for r in rows)
        assert all(r["md5"] != "a" * 32 or r["status"] == "cancelled" for r in rows)


class TestCancelDuring:
    def test_cancel_during_transport_lands_cancelled_not_completed(
        self, history_db: str, out_dir: str, tmp_path: Path
    ) -> None:
        cancel = threading.Event()
        artifact = tmp_path / "partial.epub"
        artifact.write_bytes(b"partial-bytes")

        def download_fn(md5, out, cancel_ev, on_progress):
            # Simulate mid-flight cancel after some progress.
            if on_progress is not None:
                on_progress(50, 100)
            cancel_ev.set()
            return str(artifact)  # transport may return a path; lifecycle must still cancel

        path, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            cancel=cancel,
            download_fn=download_fn,
        )

        assert path is None
        statuses = _statuses(events)
        assert "cancelled" in statuses
        assert statuses[-1] == "cancelled"
        assert "completed" not in statuses
        assert "started" not in statuses

        rows = get_download_history(db_path=history_db, limit=5)
        assert len(rows) == 1
        assert rows[0]["status"] == "cancelled"


class TestCompletedWithMetaSpine:
    def test_completed_records_history_and_persists_meta(self, history_db: str, out_dir: str, tmp_path: Path) -> None:
        artifact = Path(out_dir) / "Great Gatsby - F Scott Fitzgerald.epub"
        content = b"epub-bytes-here"
        artifact.write_bytes(content)

        meta = {
            "author": "F. Scott Fitzgerald",
            "year": 1925,
            "extension": "epub",
            "language": "English",
            "publisher": "Scribner",
            "cover_url": "https://example.com/cover.jpg",
            "content_type": "book_fiction",
        }

        def download_fn(md5, out, cancel_ev, on_progress):
            if on_progress is not None:
                on_progress(len(content), len(content))
            return str(artifact)

        path, events, _facts = _run(
            md5="b" * 32,
            title="The Great Gatsby",
            out_dir=out_dir,
            history_db=history_db,
            meta=meta,
            download_fn=download_fn,
        )

        assert path is not None
        assert Path(path).exists()
        statuses = _statuses(events)
        assert statuses[0] == "downloading"
        assert statuses[-1] == "completed"
        assert "started" not in statuses
        assert set(statuses).issubset(PUBLIC_STATUSES)

        completed = events[-1]
        assert completed["filename"] == artifact.name
        assert completed["progress_percent"] == 100.0
        assert completed["downloaded_bytes"] == len(content)
        assert completed["total_bytes"] == len(content)

        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM downloads WHERE md5 = ?", ("b" * 32,)).fetchone()
        assert row is not None
        assert row["status"] == "completed"
        assert row["title"] == "The Great Gatsby"
        assert row["author"] == "F. Scott Fitzgerald"
        assert row["year"] == 1925
        assert row["extension"] == "epub"
        assert row["language"] == "English"
        assert row["publisher"] == "Scribner"
        assert row["cover_url"] == "https://example.com/cover.jpg"
        assert row["content_type"] == "book_fiction"
        assert row["filename"] == artifact.name
        assert row["filesize_bytes"] == len(content)


class TestFailed:
    def test_failed_transport_returns_none_with_error(self, history_db: str, out_dir: str) -> None:
        def download_fn(md5, out, cancel_ev, on_progress):
            raise RuntimeError("mirror 503 unavailable")

        path, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
        )

        assert path is None
        statuses = _statuses(events)
        assert statuses[-1] == "failed"
        assert "started" not in statuses
        assert events[-1]["error"] is not None
        assert "503" in events[-1]["error"]

        rows = get_download_history(db_path=history_db, limit=5)
        assert rows[0]["status"] == "failed"
        assert "503" in (rows[0].get("error") or "")

    def test_transport_returns_none_is_failed(self, history_db: str, out_dir: str) -> None:
        def download_fn(md5, out, cancel_ev, on_progress):
            return None

        path, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
        )

        assert path is None
        assert _statuses(events)[-1] == "failed"
        assert events[-1]["error"]


class TestProgressSink:
    def test_progress_sink_receives_byte_updates(self, history_db: str, out_dir: str, tmp_path: Path) -> None:
        artifact = Path(out_dir) / "book.pdf"
        artifact.write_bytes(b"x" * 100)
        progress_calls: list[tuple[int, int]] = []

        def download_fn(md5, out, cancel_ev, on_progress):
            assert on_progress is not None
            on_progress(25, 100)
            on_progress(75, 100)
            on_progress(100, 100)
            return str(artifact)

        def on_progress(downloaded: int, total: int) -> None:
            progress_calls.append((downloaded, total))

        path, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_progress=on_progress,
        )

        assert path is not None
        assert progress_calls == [(25, 100), (75, 100), (100, 100)]

        # Progress also surfaces on the public status stream while downloading.
        mid = [e for e in events if e["status"] == "downloading" and e.get("downloaded_bytes")]
        assert any(e["downloaded_bytes"] == 25 and e["total_bytes"] == 100 for e in mid)
        assert any(e["downloaded_bytes"] == 75 for e in mid)


class TestNoStartedInStatuses:
    def test_public_stream_never_emits_started(self, history_db: str, out_dir: str, tmp_path: Path) -> None:
        artifact = Path(out_dir) / "ok.epub"
        artifact.write_bytes(b"ok")

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        _, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
        )
        assert "started" not in _statuses(events)
        assert all(s in PUBLIC_STATUSES for s in _statuses(events))

    def test_failed_path_never_emits_started(self, history_db: str, out_dir: str) -> None:
        def download_fn(md5, out, cancel_ev, on_progress):
            raise ValueError("boom")

        _, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
        )
        assert "started" not in _statuses(events)


class TestRetentionConstant:
    def test_terminal_retention_is_exported(self) -> None:
        assert TERMINAL_RETENTION_S == 300.0


class TestTerminalEvent:
    """Terminal event fact built once inside lifecycle; delivered via sink."""

    def test_completed_emits_one_fact_with_outcome_fields(self, history_db: str, out_dir: str) -> None:
        artifact = Path(out_dir) / "Gatsby.epub"
        content = b"x" * 200
        artifact.write_bytes(content)

        def download_fn(md5, out, cancel_ev, on_progress):
            time.sleep(0.05)  # ensure measurable duration
            if on_progress is not None:
                on_progress(len(content), len(content))
            return str(artifact)

        path, events, facts = _run(
            md5="c" * 32,
            title="Gatsby",
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            strategy=ChromeStrategy(proxies=[]),
            proxies=[],
        )

        assert path is not None
        assert _statuses(events)[-1] == "completed"
        assert len(facts) == 1
        fact = facts[0]
        assert fact["md5"] == "c" * 32
        assert fact["title"] == "Gatsby"
        assert fact["status"] == "completed"
        assert fact["extension"] == "epub"
        assert fact["file_size_bytes"] == len(content)
        assert fact["duration_seconds"] is not None
        assert fact["duration_seconds"] >= 0
        assert fact["avg_speed_bps"] is not None
        assert fact["avg_speed_bps"] > 0
        assert fact["error_message"] is None
        assert fact["strategy"] == "chrome"
        assert fact["mirror_domain"] is None  # not yet surfaced by transport
        assert fact["proxy_used"] is False

    def test_failed_emits_one_fact_with_error(self, history_db: str, out_dir: str) -> None:
        def download_fn(md5, out, cancel_ev, on_progress):
            raise RuntimeError("mirror 503 unavailable")

        path, _events, facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            strategy=DirectHTTPStrategy(proxies=["http://proxy.example:8080"]),
            proxies=["http://proxy.example:8080"],
        )

        assert path is None
        assert len(facts) == 1
        fact = facts[0]
        assert fact["status"] == "failed"
        assert fact["error_message"] is not None
        assert "503" in fact["error_message"]
        assert fact["strategy"] == "direct"
        assert fact["proxy_used"] is True
        assert fact["file_size_bytes"] is None

    def test_cancelled_before_start_emits_one_fact(self, history_db: str, out_dir: str) -> None:
        cancel = threading.Event()
        cancel.set()

        def download_fn(md5, out, cancel_ev, on_progress):
            raise AssertionError("transport must not run")

        path, _events, facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            cancel=cancel,
            download_fn=download_fn,
            strategy=ChromeStrategy(),
        )

        assert path is None
        assert len(facts) == 1
        assert facts[0]["status"] == "cancelled"
        assert facts[0]["strategy"] == "chrome"
        assert facts[0]["error_message"] is None

    def test_cancelled_during_emits_one_fact(self, history_db: str, out_dir: str, tmp_path: Path) -> None:
        cancel = threading.Event()
        artifact = tmp_path / "partial.epub"
        artifact.write_bytes(b"partial")

        def download_fn(md5, out, cancel_ev, on_progress):
            if on_progress is not None:
                on_progress(10, 100)
            cancel_ev.set()
            return str(artifact)

        path, events, facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            cancel=cancel,
            download_fn=download_fn,
            strategy=ChromeStrategy(),
        )

        assert path is None
        assert _statuses(events)[-1] == "cancelled"
        assert len(facts) == 1
        assert facts[0]["status"] == "cancelled"
        assert "completed" not in {f["status"] for f in facts}

    def test_terminal_once_despite_progress_updates(self, history_db: str, out_dir: str) -> None:
        artifact = Path(out_dir) / "once.pdf"
        artifact.write_bytes(b"x" * 50)

        def download_fn(md5, out, cancel_ev, on_progress):
            # Many progress updates must not create extra terminal facts.
            for n in (10, 20, 30, 40, 50):
                if on_progress is not None:
                    on_progress(n, 50)
            return str(artifact)

        path, events, facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            strategy=ChromeStrategy(),
        )

        assert path is not None
        assert len([e for e in events if e["status"] == "downloading"]) >= 2
        assert len(facts) == 1
        assert facts[0]["status"] == "completed"

    def test_no_sink_is_noop(self, history_db: str, out_dir: str) -> None:
        """CLI path: omit on_terminal_fact; lifecycle still completes cleanly."""
        artifact = Path(out_dir) / "cli.epub"
        artifact.write_bytes(b"cli")

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        path, events, facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            capture_terminal=False,
        )

        assert path is not None
        assert _statuses(events)[-1] == "completed"
        assert facts == []

    def test_sink_exception_does_not_break_download(self, history_db: str, out_dir: str) -> None:
        artifact = Path(out_dir) / "ok.epub"
        artifact.write_bytes(b"ok")

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def bad_sink(fact: dict[str, Any]) -> None:
            raise RuntimeError("telemetry down")

        path, events, facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_terminal_fact=bad_sink,
        )

        assert path is not None
        assert _statuses(events)[-1] == "completed"
        # Capture still recorded before re-raise path — sink was invoked once.
        assert len(facts) == 1

    def test_build_terminal_fact_shape(self) -> None:
        fact = build_terminal_fact(
            md5="d" * 32,
            title="T",
            status="completed",
            started_at=1000.0,
            file_path=r"C:\downloads\Book.epub",
            total_bytes=1000,
            error=None,
            strategy="chrome",
            mirror_domain="cdn.example.com",
            proxy_used=False,
            ended_at=1010.0,
        )
        assert fact["md5"] == "d" * 32
        assert fact["title"] == "T"
        assert fact["status"] == "completed"
        assert fact["extension"] == "epub"
        assert fact["file_size_bytes"] == 1000
        assert fact["duration_seconds"] == 10.0
        assert fact["avg_speed_bps"] == 100
        assert fact["mirror_domain"] == "cdn.example.com"
        assert fact["strategy"] == "chrome"
        assert fact["proxy_used"] is False
        assert fact["error_message"] is None

    def test_strategy_label_known_and_unknown(self) -> None:
        assert strategy_label(ChromeStrategy()) == "chrome"
        assert strategy_label(DirectHTTPStrategy()) == "direct"
        assert strategy_label(MagicMock()) is None
        assert strategy_label(None) is None


class TestOnCompletedHook:
    """Injectible on_completed: Category-after-Artifact seam entry from lifecycle."""

    def test_completed_invokes_on_completed_once_after_terminal(self, history_db: str, out_dir: str) -> None:
        artifact = Path(out_dir) / "track.m4b"
        artifact.write_bytes(b"audio-bytes")
        completed_calls: list[tuple[str, str, str]] = []
        order: list[str] = []

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def on_completed(md5: str, file_path: str, completed_out: str) -> None:
            order.append("on_completed")
            completed_calls.append((md5, file_path, completed_out))

        def on_status_track(payload: dict[str, Any]) -> None:
            if payload.get("status") == "completed":
                order.append("status_completed")

        events: list[dict[str, Any]] = []
        tok = threading.Event()

        def on_status(payload: dict[str, Any]) -> None:
            events.append(dict(payload))
            on_status_track(payload)

        path = run_download(
            md5="e" * 32,
            title="Audio",
            out_dir=out_dir,
            history_db=history_db,
            strategy=MagicMock(),
            on_status=on_status,
            cancel=tok,
            proxies=[],
            download_fn=download_fn,
            on_completed=on_completed,
        )

        assert path is not None
        assert len(completed_calls) == 1
        call_md5, call_path, call_out = completed_calls[0]
        assert call_md5 == "e" * 32
        assert Path(call_path) == Path(artifact).resolve() or call_path == str(Path(artifact).resolve())
        assert call_out == out_dir
        # Download terminal (bytes done) before Category hook.
        assert "status_completed" in order
        assert order.index("status_completed") < order.index("on_completed")
        assert _statuses(events)[-1] == "completed"

    def test_on_completed_not_called_on_failed(self, history_db: str, out_dir: str) -> None:
        calls: list[object] = []

        def download_fn(md5, out, cancel_ev, on_progress):
            return None

        def on_completed(*args):
            calls.append(args)

        path, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_completed=on_completed,
        )
        assert path is None
        assert _statuses(events)[-1] == "failed"
        assert calls == []

    def test_on_completed_not_called_on_cancelled(self, history_db: str, out_dir: str) -> None:
        calls: list[object] = []
        cancel = threading.Event()
        cancel.set()

        def download_fn(md5, out, cancel_ev, on_progress):
            raise AssertionError("must not run")

        def on_completed(*args):
            calls.append(args)

        path, events, _facts = _run(
            out_dir=out_dir,
            history_db=history_db,
            cancel=cancel,
            download_fn=download_fn,
            on_completed=on_completed,
        )
        assert path is None
        assert _statuses(events)[-1] == "cancelled"
        assert calls == []

    def test_on_completed_exception_does_not_uncomplete(self, history_db: str, out_dir: str) -> None:
        artifact = Path(out_dir) / "ok.epub"
        artifact.write_bytes(b"ok")

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def boom(md5, path, out):
            raise RuntimeError("category boom")

        path, events, _facts = _run(
            md5="f" * 32,
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_completed=boom,
        )
        assert path is not None
        assert _statuses(events)[-1] == "completed"
        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT status FROM downloads WHERE md5 = ?", ("f" * 32,)).fetchone()
        assert row["status"] == "completed"


class TestCategoryAfterArtifactSeam:
    """Category-after-Artifact via lifecycle on_completed + apply_category_after_artifact.

    Covers: single-file audio → Audiobook + process; archive with audio → enqueue;
    archive without audio → Book no enqueue; never “not zip ⇒ Book” for audio files.
    """

    def test_single_file_audio_stamps_audiobook_and_enqueues(self, history_db: str, out_dir: str) -> None:
        from src.audiobook_processor import apply_category_after_artifact

        artifact = Path(out_dir) / "Novel.m4b"
        artifact.write_bytes(b"m4b-bytes")
        enqueued: list[tuple[str, str, str]] = []

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def on_completed(md5: str, file_path: str, completed_out: str) -> None:
            apply_category_after_artifact(
                md5,
                file_path,
                completed_out,
                db_path=history_db,
                enqueue_fn=lambda m, p, o: enqueued.append((m, p, o)),
            )

        path, events, _facts = _run(
            md5="1" * 32,
            title="Novel Audio",
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_completed=on_completed,
        )

        assert path is not None
        assert _statuses(events)[-1] == "completed"
        assert len(enqueued) == 1
        assert enqueued[0][0] == "1" * 32
        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT status, media_type FROM downloads WHERE md5 = ?", ("1" * 32,)).fetchone()
        assert row["status"] == "completed"
        assert row["media_type"] == "audiobook"

    def test_archive_with_audio_enqueues_and_stamps_audiobook(
        self, history_db: str, out_dir: str, tmp_path: Path
    ) -> None:
        import zipfile

        from src.audiobook_processor import apply_category_after_artifact
        from src.media_tools import find_7z

        try:
            find_7z()
        except FileNotFoundError:
            pytest.skip("7z not available")

        artifact = Path(out_dir) / "pack.zip"
        with zipfile.ZipFile(artifact, "w") as zf:
            zf.writestr("track01.mp3", b"fake-mp3")
            zf.writestr("cover.jpg", b"jpg")
        enqueued: list[tuple[str, str, str]] = []

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def on_completed(md5: str, file_path: str, completed_out: str) -> None:
            apply_category_after_artifact(
                md5,
                file_path,
                completed_out,
                db_path=history_db,
                enqueue_fn=lambda m, p, o: enqueued.append((m, p, o)),
            )

        path, events, _facts = _run(
            md5="2" * 32,
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_completed=on_completed,
        )

        assert path is not None
        assert _statuses(events)[-1] == "completed"
        assert len(enqueued) == 1
        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT media_type FROM downloads WHERE md5 = ?", ("2" * 32,)).fetchone()
        assert row["media_type"] == "audiobook"

    def test_archive_without_audio_stamps_book_no_enqueue(self, history_db: str, out_dir: str) -> None:
        import zipfile

        from src.audiobook_processor import apply_category_after_artifact
        from src.media_tools import find_7z

        try:
            find_7z()
        except FileNotFoundError:
            pytest.skip("7z not available")

        artifact = Path(out_dir) / "ebooks.zip"
        with zipfile.ZipFile(artifact, "w") as zf:
            zf.writestr("a.pdf", b"%PDF-1.4")
            zf.writestr("b.epub", b"PK")
        enqueued: list[tuple[str, str, str]] = []

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def on_completed(md5: str, file_path: str, completed_out: str) -> None:
            apply_category_after_artifact(
                md5,
                file_path,
                completed_out,
                db_path=history_db,
                enqueue_fn=lambda m, p, o: enqueued.append((m, p, o)),
            )

        path, events, _facts = _run(
            md5="3" * 32,
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_completed=on_completed,
        )

        assert path is not None
        assert _statuses(events)[-1] == "completed"
        assert enqueued == []
        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT media_type FROM downloads WHERE md5 = ?", ("3" * 32,)).fetchone()
        assert row["media_type"] == "book"

    def test_plain_epub_stamps_book_not_because_not_zip(self, history_db: str, out_dir: str) -> None:
        """Book single-file is book; contrast with single-file audio (not “not zip ⇒ book”)."""
        from src.audiobook_processor import apply_category_after_artifact

        artifact = Path(out_dir) / "Novel.epub"
        artifact.write_bytes(b"epub")
        enqueued: list[object] = []

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def on_completed(md5: str, file_path: str, completed_out: str) -> None:
            apply_category_after_artifact(
                md5,
                file_path,
                completed_out,
                db_path=history_db,
                enqueue_fn=lambda m, p, o: enqueued.append((m, p, o)),
            )

        path, _events, _facts = _run(
            md5="4" * 32,
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_completed=on_completed,
        )

        assert path is not None
        assert enqueued == []
        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT media_type FROM downloads WHERE md5 = ?", ("4" * 32,)).fetchone()
        assert row["media_type"] == "book"

    def test_category_failure_leaves_completed_row_intact(self, history_db: str, out_dir: str) -> None:
        from unittest.mock import patch

        from src.audiobook_processor import apply_category_after_artifact

        artifact = Path(out_dir) / "ok.pdf"
        artifact.write_bytes(b"pdf")

        def download_fn(md5, out, cancel_ev, on_progress):
            return str(artifact)

        def on_completed(md5: str, file_path: str, completed_out: str) -> None:
            def bad_enqueue(m, p, o):
                raise RuntimeError("queue down")

            # Claim audiobook so enqueue runs and fails — download must stay completed.
            with patch("src.audiobook_processor.classify", return_value="audiobook"):
                apply_category_after_artifact(
                    md5,
                    file_path,
                    completed_out,
                    db_path=history_db,
                    enqueue_fn=bad_enqueue,
                )

        path, events, _facts = _run(
            md5="5" * 32,
            out_dir=out_dir,
            history_db=history_db,
            download_fn=download_fn,
            on_completed=on_completed,
        )
        assert path is not None
        assert _statuses(events)[-1] == "completed"
        with sqlite3.connect(history_db) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT status, media_type, filename FROM downloads WHERE md5 = ?",
                ("5" * 32,),
            ).fetchone()
        assert row["status"] == "completed"
        assert row["filename"] == "ok.pdf"
        assert row["media_type"] == "audiobook"  # stamped before enqueue failed
