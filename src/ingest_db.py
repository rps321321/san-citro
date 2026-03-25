import sqlite3
import json
import time
import zstandard as zstd
import sys
import os
import io
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from tqdm import tqdm
from .logger import get_logger

logger = get_logger()

COMMIT_BATCH_SIZE = 2000
CHECKPOINT_INTERVAL = 5000  # Save byte offset every N records


@dataclass
class IngestStats:
    """Tracks running statistics for an ingest operation."""
    total_records: int = 0
    skipped_records: int = 0
    bytes_processed: int = 0
    start_time: float = field(default_factory=time.monotonic)

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.start_time

    @property
    def records_per_second(self) -> float:
        elapsed = self.elapsed_seconds
        return self.total_records / elapsed if elapsed > 0 else 0.0

    def format_elapsed(self) -> str:
        elapsed = self.elapsed_seconds
        hours, remainder = divmod(int(elapsed), 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours:
            return f"{hours}h {minutes}m {seconds}s"
        if minutes:
            return f"{minutes}m {seconds}s"
        return f"{seconds}s"

    def format_rate(self) -> str:
        rate = self.records_per_second
        if rate >= 1000:
            return f"{rate / 1000:.1f}k rec/s"
        return f"{rate:.0f} rec/s"


def init_db(db_path: str) -> sqlite3.Connection:
    """Initializes the SQLite database with high-performance settings.

    Creates the records table if missing, and ensures the FTS5 virtual table,
    ingest_metadata tracking table, and sync trigger exist (without dropping
    existing data).
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Industrial Tuning
    cursor.execute("PRAGMA journal_mode = WAL")
    cursor.execute("PRAGMA synchronous = NORMAL")
    cursor.execute("PRAGMA cache_size = -64000")  # 64 MB

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS records (
            md5 TEXT PRIMARY KEY,
            title TEXT, author TEXT, year TEXT, extension TEXT, language TEXT,
            filesize_bytes INTEGER, isbn13 TEXT, publisher TEXT, description TEXT
        )
    """)

    # Ingest metadata for incremental ingestion and crash recovery
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ingest_metadata (
            filename TEXT PRIMARY KEY,
            file_size INTEGER,
            records_added INTEGER,
            completed_at TIMESTAMP,
            byte_offset INTEGER
        )
    """)

    # Secondary indexes for filter queries
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_extension ON records(extension)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_language ON records(language)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_records_year ON records(year)")

    # Only create FTS table if it doesn't exist (preserve existing index)
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
            md5 UNINDEXED, title, author, publisher, description
        )
    """)

    # Recreate trigger (lightweight, safe to drop/recreate)
    cursor.execute("DROP TRIGGER IF EXISTS records_ai")
    cursor.execute("""
        CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
          INSERT OR IGNORE INTO records_fts(md5, title, author, publisher, description)
          VALUES (new.md5, new.title, new.author, new.publisher, new.description);
        END;
    """)

    conn.commit()
    return conn


def get_ingest_metadata(conn: sqlite3.Connection, filename: str) -> Optional[Dict[str, Any]]:
    """Retrieves ingest metadata for a given filename, or None if not found."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT filename, file_size, records_added, completed_at, byte_offset "
        "FROM ingest_metadata WHERE filename = ?",
        (filename,),
    )
    row = cursor.fetchone()
    if row is None:
        return None
    return {
        "filename": row[0],
        "file_size": row[1],
        "records_added": row[2],
        "completed_at": row[3],
        "byte_offset": row[4],
    }


def save_ingest_progress(
    conn: sqlite3.Connection,
    filename: str,
    file_size: int,
    records_added: int,
    byte_offset: int,
    completed: bool = False,
) -> None:
    """Saves or updates ingest progress for crash recovery and skip detection."""
    completed_at = datetime.now(timezone.utc).isoformat() if completed else None
    conn.execute(
        """
        INSERT INTO ingest_metadata (filename, file_size, records_added, completed_at, byte_offset)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(filename) DO UPDATE SET
            file_size = excluded.file_size,
            records_added = excluded.records_added,
            completed_at = excluded.completed_at,
            byte_offset = excluded.byte_offset
        """,
        (filename, file_size, records_added, completed_at, byte_offset),
    )
    conn.commit()


def is_already_ingested(conn: sqlite3.Connection, filename: str, file_size: int) -> bool:
    """Returns True if the file has been fully ingested with the same size."""
    meta = get_ingest_metadata(conn, filename)
    if meta is None:
        return False
    return meta["completed_at"] is not None and meta["file_size"] == file_size


def optimize_db(db_path: str) -> None:
    """Shrinks and optimizes the database for search performance."""
    if not os.path.exists(db_path):
        return
    logger.info(f"Optimizing database: {db_path}...")
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA optimize")
        conn.execute("VACUUM")
    logger.info("Database optimization complete.")


def _log_checkpoint(stats: IngestStats) -> None:
    """Logs a progress checkpoint at regular intervals."""
    logger.info(
        f"Checkpoint: {stats.total_records:,} records ingested "
        f"({stats.format_rate()}, {stats.format_elapsed()} elapsed, "
        f"{stats.skipped_records:,} skipped)"
    )


def _format_size(size_bytes: int) -> str:
    """Formats byte count into a human-readable string."""
    if size_bytes >= 1024 ** 3:
        return f"{size_bytes / (1024 ** 3):.2f} GB"
    if size_bytes >= 1024 ** 2:
        return f"{size_bytes / (1024 ** 2):.1f} MB"
    if size_bytes >= 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes} B"


def _print_final_summary(stats: IngestStats, db_path: str) -> None:
    """Logs a final summary after ingestion completes."""
    db_size = os.path.getsize(db_path) if os.path.exists(db_path) else 0
    logger.info("=" * 60)
    logger.info("INGEST COMPLETE")
    logger.info(f"  Total records : {stats.total_records:,}")
    logger.info(f"  Skipped       : {stats.skipped_records:,}")
    logger.info(f"  Elapsed time  : {stats.format_elapsed()}")
    logger.info(f"  Average rate  : {stats.format_rate()}")
    logger.info(f"  Database size : {_format_size(db_size)}")
    logger.info("=" * 60)


def ingest_file(db_path: str, zst_file_path: str, force: bool = False) -> None:
    """Ingests a .jsonl.zst file into the database.

    Supports incremental ingest: already-completed files are skipped unless
    ``force=True``. If a previous ingest crashed mid-way, it resumes from the
    last checkpointed byte offset.

    Features dual progress bars (records + bytes) and periodic checkpoints
    with rate/elapsed reporting.
    """
    if not os.path.exists(zst_file_path):
        logger.error(f"File not found: {zst_file_path}")
        sys.exit(1)

    conn: Optional[sqlite3.Connection] = None
    stats = IngestStats()
    try:
        conn = init_db(db_path)
        cursor = conn.cursor()

        file_size = os.path.getsize(zst_file_path)
        filename = os.path.basename(zst_file_path)

        # --- Incremental ingest check ---
        if not force and is_already_ingested(conn, filename, file_size):
            logger.info(
                f"Skipping '{filename}': already fully ingested. "
                "Use --force to re-ingest."
            )
            return

        # --- Crash recovery: determine resume offset ---
        resume_offset = 0
        prior_records = 0
        meta = get_ingest_metadata(conn, filename)
        if meta is not None and meta["completed_at"] is None and not force:
            resume_offset = meta["byte_offset"] or 0
            prior_records = meta["records_added"] or 0
            logger.info(
                f"Resuming '{filename}' from byte offset {resume_offset} "
                f"({prior_records} records already added)"
            )
        elif force and meta is not None:
            logger.info(f"Force re-ingesting '{filename}' from the beginning.")

        dctx = zstd.ZstdDecompressor()

        with open(zst_file_path, "rb") as fh:
            # Seek to the resume offset in the compressed stream
            if resume_offset > 0:
                fh.seek(resume_offset)

            # Primary bar: records processed (with rate)
            record_bar = tqdm(
                unit=" rec",
                desc="Records",
                position=0,
                dynamic_ncols=True,
                smoothing=0.1,
                initial=prior_records,
            )
            # Secondary bar: compressed bytes read
            byte_bar = tqdm(
                total=file_size,
                unit="B",
                unit_scale=True,
                desc="Bytes",
                position=1,
                dynamic_ncols=True,
                leave=True,
                initial=resume_offset,
            )

            try:
                with dctx.stream_reader(fh) as reader:
                    text_stream = io.TextIOWrapper(reader, encoding="utf-8")
                    for line in text_stream:
                        # Update byte bar from compressed file position
                        current_offset = fh.tell()
                        byte_bar.n = current_offset
                        byte_bar.refresh()

                        if not line.strip():
                            continue
                        try:
                            r = json.loads(line)
                            cursor.execute(
                                """
                                INSERT OR IGNORE INTO records (
                                    md5, title, author, year, extension,
                                    language, filesize_bytes, isbn13, publisher, description
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                                (
                                    r.get("md5"),
                                    r.get("title"),
                                    r.get("author"),
                                    r.get("year"),
                                    r.get("extension"),
                                    r.get("language"),
                                    r.get("filesize_bytes"),
                                    r.get("isbn13"),
                                    r.get("publisher"),
                                    r.get("description"),
                                ),
                            )
                            stats.total_records += 1
                            record_bar.update(1)

                            if stats.total_records % COMMIT_BATCH_SIZE == 0:
                                conn.commit()

                            # Periodic checkpoint for crash recovery and logging
                            if stats.total_records % CHECKPOINT_INTERVAL == 0:
                                save_ingest_progress(
                                    conn, filename, file_size,
                                    prior_records + stats.total_records, current_offset,
                                )
                                _log_checkpoint(stats)

                        except json.JSONDecodeError as e:
                            stats.skipped_records += 1
                            logger.debug(f"Skipped malformed JSON line: {e}")
                        except sqlite3.Error as e:
                            stats.skipped_records += 1
                            logger.debug(f"Skipped record (DB error): {e}")

                    conn.commit()

                    # Finalize bars
                    byte_bar.n = file_size
                    byte_bar.refresh()
            finally:
                record_bar.close()
                byte_bar.close()

        # Mark ingest as complete
        total_records = prior_records + stats.total_records
        save_ingest_progress(conn, filename, file_size, total_records, file_size, completed=True)
        _print_final_summary(stats, db_path)
    finally:
        if conn:
            conn.close()

    # Optimize AFTER connection is closed (VACUUM needs exclusive access)
    optimize_db(db_path)
