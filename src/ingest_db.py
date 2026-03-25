import sqlite3
import json
import zstandard as zstd
import sys
import os
import io
from typing import Optional
from tqdm import tqdm
from logger import get_logger

logger = get_logger()

COMMIT_BATCH_SIZE = 2000


def init_db(db_path: str) -> sqlite3.Connection:
    """Initializes the SQLite database with high-performance settings.

    Creates the records table if missing, and ensures the FTS5 virtual table
    and its sync trigger exist (without dropping existing data).
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


def optimize_db(db_path: str) -> None:
    """Shrinks and optimizes the database for search performance."""
    if not os.path.exists(db_path):
        return
    logger.info(f"Optimizing database: {db_path}...")
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA optimize")
        conn.execute("VACUUM")
    logger.info("Database optimization complete.")


def ingest_file(db_path: str, zst_file_path: str) -> None:
    if not os.path.exists(zst_file_path):
        logger.error(f"File not found: {zst_file_path}")
        sys.exit(1)

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = init_db(db_path)
        cursor = conn.cursor()

        file_size = os.path.getsize(zst_file_path)
        dctx = zstd.ZstdDecompressor()
        count = 0
        skipped = 0

        with open(zst_file_path, "rb") as fh:
            with tqdm(total=file_size, unit="B", unit_scale=True, desc="Ingesting") as pbar:
                with dctx.stream_reader(fh) as reader:
                    text_stream = io.TextIOWrapper(reader, encoding="utf-8")
                    for line in text_stream:
                        pbar.n = fh.tell()
                        pbar.refresh()
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
                            count += 1
                            if count % COMMIT_BATCH_SIZE == 0:
                                conn.commit()
                        except json.JSONDecodeError as e:
                            skipped += 1
                            logger.debug(f"Skipped malformed JSON line: {e}")
                        except sqlite3.Error as e:
                            skipped += 1
                            logger.debug(f"Skipped record (DB error): {e}")

                    conn.commit()
                    pbar.n = file_size
                    pbar.refresh()

        logger.info(f"Ingested {count} records. Skipped {skipped}.")
    finally:
        if conn:
            conn.close()

    # Optimize AFTER connection is closed (VACUUM needs exclusive access)
    optimize_db(db_path)
