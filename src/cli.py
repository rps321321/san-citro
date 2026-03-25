import argparse
import sys
import os
import sqlite3
import re
from typing import Optional
from rich.console import Console

# Ensure we can import sibling modules when run directly
sys.path.insert(0, os.path.dirname(__file__))

from annas_archive_tool import AnnasArchiveTool
from ingest_db import ingest_file, optimize_db
from search_local import search_db, print_results
from config_manager import get_config, save_config
from logger import setup_logging, get_logger
from diagnostics import run_diagnostics

console = Console()


def get_filename_from_db(db_path: str, md5: str) -> Optional[str]:
    """Helper to get a clean filename from the DB."""
    if not db_path or not os.path.exists(db_path):
        return None
    try:
        with sqlite3.connect(db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT title, extension FROM records WHERE md5 = ?", (md5,))
            result = cursor.fetchone()
        if result:
            title, ext = result
            clean_title = re.sub(r'[^a-zA-Z0-9_\-\. ]', '_', title)
            return f"{clean_title}.{ext}" if ext else f"{clean_title}.file"
    except sqlite3.Error as e:
        get_logger().debug(f"Failed to get filename from DB: {e}")
    return None


def main() -> None:
    config = get_config()

    parser = argparse.ArgumentParser(
        description="Anna's Archive Toolkit - VPN Edition",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    # Global flags
    parser.add_argument("--verbose", action="store_true", help="Enable detailed verbose logging")
    parser.add_argument(
        "--direct", action="store_true", help="VPN MODE: Bypass all proxy logic for direct connection"
    )

    subparsers = parser.add_subparsers(dest="command", required=True, help="Available commands")

    subparsers.add_parser("init", help="Set defaults")
    subparsers.add_parser("refresh-proxies", help="Fetch fresh proxies")
    subparsers.add_parser("diagnose", help="Check system health")
    subparsers.add_parser("stats", help="Show statistics")
    subparsers.add_parser("optimize", help="Compress database")
    subparsers.add_parser("fetch", help="Get latest magnet links")

    search_p = subparsers.add_parser("search", help="Advanced Local Search")
    search_p.add_argument("query")
    snatch_p = subparsers.add_parser("snatch", help="Interactive Multi-Snatch")
    snatch_p.add_argument("query")
    batch_p = subparsers.add_parser("batch-snatch", help="Process a wishlist")
    batch_p.add_argument("file_path")
    download_p = subparsers.add_parser("download", help="Direct Download by MD5")
    download_p.add_argument("md5")

    args = parser.parse_args()
    logger = setup_logging(verbose=args.verbose)

    active_db = config.get("db_path")
    active_out = config.get("out_dir", "downloads")
    active_proxies = config.get("proxies", [])

    try:
        tool = AnnasArchiveTool(proxies=active_proxies, direct_mode=args.direct)
    except ConnectionError as e:
        console.print(f"\n[bold red]HALT:[/bold red] {e}")
        sys.exit(1)

    if args.command in ("batch-snatch", "snatch"):
        targets = []
        if args.command == "snatch":
            res = search_db(active_db, args.query, limit=20, download_dir=active_out)
            if not res:
                return
            print_results(res, download_dir=active_out)
            choice = console.input("\n[bold cyan]Select numbers (e.g. 1,3):[/bold cyan] ")
            try:
                indices = [int(i.strip()) - 1 for i in choice.split(",")]
                targets = [res[i] for i in indices if 0 <= i < len(res)]
            except (ValueError, IndexError) as e:
                logger.error(f"Invalid selection: {e}")
                return
        else:  # batch-snatch
            with open(args.file_path, "r") as f:
                queries = [line.strip() for line in f if line.strip()]
            for q in queries:
                res = search_db(active_db, q, limit=1)
                if res:
                    targets.append(res[0])

        console.print(
            f"\n[bold magenta]Starting Sequential Download Queue:[/bold magenta] {len(targets)} books."
        )
        for item in targets:
            md5 = item[4]
            filename = get_filename_from_db(active_db, md5)
            tool.automated_slow_download(md5, output_dir=active_out, custom_filename=filename)

    elif args.command == "search":
        print_results(
            search_db(active_db, args.query, download_dir=active_out), download_dir=active_out
        )
    elif args.command == "diagnose":
        run_diagnostics(config)
    elif args.command == "optimize":
        if active_db:
            optimize_db(active_db)
        else:
            console.print("[yellow]No database configured.[/yellow]")
    elif args.command == "fetch":
        dumps = tool.get_metadata_dumps()
        if dumps:
            latest = dumps[-1]
            console.print(f"\n[bold green]Latest dump:[/bold green] {latest.get('display_name', 'N/A')}")
            console.print(f"[bold blue]Magnet:[/bold blue] {latest.get('magnet_link', 'N/A')}")
        else:
            console.print("[yellow]No metadata dumps found.[/yellow]")
    elif args.command == "download":
        filename = get_filename_from_db(active_db, args.md5)
        tool.automated_slow_download(args.md5, output_dir=active_out, custom_filename=filename)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        get_logger().critical(f"FATAL: {e}", exc_info=True)
        sys.exit(1)
