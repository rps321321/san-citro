import argparse
import sqlite3
import sys
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Optional, List
from rich.console import Console
from rich.table import Table
from rich import box

from .annas_archive_tool import AnnasArchiveTool
from .scraper import scrape_annas_archive
from .config_manager import get_config, set_config_path
from .logger import setup_logging, get_logger
from .diagnostics import run_diagnostics
from .download_strategy import create_strategy
from .shutdown import install_signal_handlers, is_cancelled
from .utils import format_filesize
from .download_history import (
    init_downloads_table,
    record_download_start,
    record_download_complete,
    record_download_failed,
    get_download_history,
)

MD5_LINE_PATTERN = re.compile(r"^[a-fA-F0-9]{32}$")

console = Console()


# ------------------------------------------------------------------
# Dataclass for concurrent download results
# ------------------------------------------------------------------

@dataclass
class DownloadResult:
    """Tracks the outcome of a single download attempt."""
    md5: str
    filename: str
    status: str  # "success", "failed", "error"
    title: str = ""
    path: Optional[str] = None
    error: Optional[str] = None
    elapsed_seconds: float = 0.0


# ------------------------------------------------------------------
# Helper utilities
# ------------------------------------------------------------------

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


# ------------------------------------------------------------------
# Download history display
# ------------------------------------------------------------------

def print_download_history(history_db: Optional[str], limit: int = 20) -> None:
    """Display recent download history in a Rich table."""
    from rich import box

    rows = get_download_history(db_path=history_db, limit=limit)
    if not rows:
        console.print("\n[yellow]No download history found.[/yellow]")
        return

    table = Table(
        title="Download History",
        box=box.HORIZONTALS,
        header_style="bold cyan",
        title_style="bold magenta",
        show_lines=False,
    )
    table.add_column("#", justify="right", style="dim")
    table.add_column("Title", style="white", width=40, no_wrap=True)
    table.add_column("MD5", style="dim", width=10)
    table.add_column("Status", justify="center")
    table.add_column("Size", justify="right", style="blue")
    table.add_column("Started", style="dim")
    table.add_column("Completed", style="dim")
    table.add_column("Error", style="red", width=25, no_wrap=True)

    for idx, row in enumerate(rows, 1):
        status_raw = row.get("status", "unknown")
        if status_raw == "completed":
            status = "[bold green]completed[/bold green]"
        elif status_raw == "failed":
            status = "[bold red]failed[/bold red]"
        elif status_raw == "started":
            status = "[bold yellow]started[/bold yellow]"
        else:
            status = status_raw

        started = (row.get("started_at") or "")[:19].replace("T", " ")
        completed = (row.get("completed_at") or "")[:19].replace("T", " ")
        error_msg = row.get("error") or ""

        table.add_row(
            str(idx),
            row.get("title") or "Unknown",
            (row.get("md5") or "")[:10],
            status,
            format_filesize(row.get("filesize_bytes")),
            started,
            completed,
            error_msg[:40] if error_msg else "",
        )

    console.print(table)


# ------------------------------------------------------------------
# Tracked download wrapper (history recording)
# ------------------------------------------------------------------

def _tracked_download(
    tool: AnnasArchiveTool,
    md5: str,
    title: str,
    output_dir: str,
    filename: Optional[str],
    history_db: Optional[str],
) -> Optional[str]:
    """Wrap a single download with history tracking."""
    record_download_start(db_path=history_db, md5=md5, title=title)
    try:
        result = tool.automated_slow_download(md5, output_dir=output_dir, custom_filename=filename)
        if result:
            filesize = os.path.getsize(result) if os.path.exists(result) else 0
            record_download_complete(
                db_path=history_db,
                md5=md5,
                filename=os.path.basename(result),
                filesize_bytes=filesize,
            )
        else:
            record_download_failed(db_path=history_db, md5=md5, error="Download returned no file")
        return result
    except Exception as e:
        record_download_failed(db_path=history_db, md5=md5, error=str(e)[:500])
        raise


# ------------------------------------------------------------------
# Concurrent downloads
# ------------------------------------------------------------------

def _download_one(
    tool: AnnasArchiveTool,
    md5: str,
    output_dir: str,
    db_path: Optional[str],
    history_db: Optional[str],
) -> DownloadResult:
    """Download a single file and return a structured result. Never raises."""
    filename = get_filename_from_db(db_path, md5) or f"{md5}.file"
    title = filename
    logger = get_logger()
    start = time.monotonic()
    try:
        path = _tracked_download(
            tool, md5, title, output_dir, filename, history_db,
        )
        elapsed = time.monotonic() - start
        if path:
            return DownloadResult(
                md5=md5, filename=filename, title=title, status="success",
                path=path, elapsed_seconds=elapsed,
            )
        return DownloadResult(
            md5=md5, filename=filename, title=title, status="failed",
            error="No file returned", elapsed_seconds=elapsed,
        )
    except Exception as exc:
        elapsed = time.monotonic() - start
        logger.error(f"[{md5[:6]}] Unexpected error: {exc}")
        return DownloadResult(
            md5=md5, filename=filename, title=title, status="error",
            error=str(exc), elapsed_seconds=elapsed,
        )


def _run_concurrent_downloads(
    tool: AnnasArchiveTool,
    targets: list,
    output_dir: str,
    db_path: Optional[str],
    history_db: Optional[str],
    concurrency: int,
) -> List[DownloadResult]:
    """Execute downloads in parallel using a thread pool and return all results."""
    logger = get_logger()
    results: List[DownloadResult] = []

    console.print(
        f"\n[bold magenta]Starting Download Queue:[/bold magenta] "
        f"{len(targets)} book(s), concurrency={concurrency}"
    )

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_to_md5 = {}
        for item in targets:
            if is_cancelled():
                console.print(
                    "\n[yellow]Shutdown requested — skipping remaining downloads.[/yellow]"
                )
                break
            md5 = item[4]
            future = executor.submit(
                _download_one, tool, md5, output_dir, db_path, history_db,
            )
            future_to_md5[future] = md5

        for future in as_completed(future_to_md5):
            result = future.result()  # _download_one never raises
            results.append(result)
            if result.status == "success":
                logger.info(f"[{result.md5[:6]}] Completed: {result.filename}")
            else:
                logger.warning(
                    f"[{result.md5[:6]}] {result.status.upper()}: {result.error}"
                )

    return results


def _print_summary_table(results: List[DownloadResult]) -> None:
    """Print a rich summary table of all download outcomes."""
    table = Table(title="Download Summary", show_lines=True)
    table.add_column("#", style="dim", width=4)
    table.add_column("MD5", style="cyan", width=8)
    table.add_column("Filename", style="white", max_width=40)
    table.add_column("Status", justify="center", width=10)
    table.add_column("Time", justify="right", width=10)
    table.add_column("Details", style="dim", max_width=35)

    status_styles = {
        "success": "[bold green]OK[/bold green]",
        "failed": "[bold yellow]FAILED[/bold yellow]",
        "error": "[bold red]ERROR[/bold red]",
    }

    for idx, r in enumerate(results, 1):
        elapsed = f"{r.elapsed_seconds:.1f}s"
        detail = r.path or r.error or ""
        table.add_row(
            str(idx),
            r.md5[:8],
            r.filename[:40],
            status_styles.get(r.status, r.status),
            elapsed,
            str(detail)[:35],
        )

    console.print()
    console.print(table)

    succeeded = sum(1 for r in results if r.status == "success")
    total = len(results)
    console.print(
        f"\n[bold]Result:[/bold] {succeeded}/{total} downloads succeeded."
    )


# ------------------------------------------------------------------
# Live search result display
# ------------------------------------------------------------------

def _print_live_results(results: list[dict], page: int = 1) -> None:
    """Display live scrape results in a Rich table."""
    if not results:
        console.print("\n[yellow]No results found.[/yellow]")
        return

    table = Table(
        title="Archive Search Results (Live)",
        box=box.HORIZONTALS,
        header_style="bold cyan",
        title_style="bold magenta",
        show_lines=False,
    )
    table.add_column("#", justify="right", style="dim")
    table.add_column("Title", style="white", width=40)
    table.add_column("Author", style="green")
    table.add_column("Year", justify="center")
    table.add_column("Format", justify="center", style="bold yellow")
    table.add_column("Size", justify="right", style="blue")
    table.add_column("Lang", justify="center", style="dim")

    for idx, row in enumerate(results, 1):
        table.add_row(
            str(idx),
            row.get("title") or "Unknown",
            row.get("author") or "Unknown",
            str(row.get("year") or "N/A"),
            (row.get("extension") or "N/A").upper(),
            format_filesize(row.get("filesize_bytes")),
            row.get("language") or "N/A",
        )

    console.print(table)
    console.print(f"\n[bold]Page {page} — {len(results)} result(s)[/bold]")


# ------------------------------------------------------------------
# Shared filter argument helper
# ------------------------------------------------------------------

def _add_filter_args(p: argparse.ArgumentParser) -> None:
    """Add common search filter arguments to a subparser."""
    p.add_argument("--ext", type=str, default=None, help="Filter by file extension (e.g. pdf, epub)")
    p.add_argument("--lang", type=str, default=None, help="Filter by language (e.g. english, spanish)")
    p.add_argument("--after", type=int, default=None, help="Filter to works published on or after this year")
    p.add_argument("--limit", type=int, default=None, help="Max number of results to return")


def _build_filter_kwargs(args: argparse.Namespace) -> dict:
    """Build a dict of filter kwargs from parsed CLI args."""
    kwargs: dict[str, Any] = {}
    if getattr(args, "ext", None) is not None:
        kwargs["ext"] = args.ext
    if getattr(args, "lang", None) is not None:
        kwargs["lang"] = args.lang
    if getattr(args, "after", None) is not None:
        kwargs["after"] = args.after
    return kwargs


# ------------------------------------------------------------------
# Main entry point
# ------------------------------------------------------------------

def main() -> None:
    install_signal_handlers()

    parser = argparse.ArgumentParser(
        description="Anna's Archive Toolkit - VPN Edition",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    # Global flags
    parser.add_argument("--verbose", action="store_true", help="Enable detailed verbose logging")
    parser.add_argument(
        "--direct", action="store_true", help="VPN MODE: Bypass all proxy logic for direct connection"
    )
    parser.add_argument(
        "--config", metavar="PATH", help="Override config file path (default: platform XDG location)"
    )
    parser.add_argument(
        "--concurrency", type=int, default=None,
        help="Max parallel downloads (overrides config, default: config value or 2)",
    )
    parser.add_argument(
        "--strategy",
        choices=["chrome", "direct"],
        default="chrome",
        help="Download strategy: 'chrome' (default) uses browser automation, "
        "'direct' uses HTTP requests without a browser",
    )

    subparsers = parser.add_subparsers(dest="command", required=True, help="Available commands")

    # --- Simple commands ---
    subparsers.add_parser("diagnose", help="Check system health")
    subparsers.add_parser("fetch", help="Get latest magnet links")

    # --- Search command (live scraping) ---
    search_p = subparsers.add_parser("search", help="Search Anna's Archive (live scraping)")
    search_p.add_argument("query")
    _add_filter_args(search_p)
    search_p.add_argument("--page", type=int, default=1, help="Page number (default: 1)")

    # --- Snatch command ---
    snatch_p = subparsers.add_parser("snatch", help="Interactive Multi-Snatch")
    snatch_p.add_argument("query")
    _add_filter_args(snatch_p)
    snatch_p.add_argument("--page", type=int, default=1, help="Starting page number (default: 1)")
    snatch_p.add_argument("--per-page", type=int, default=20, help="Results per page (default: 20)")

    # --- Batch-snatch command ---
    batch_p = subparsers.add_parser("batch-snatch", help="Process a wishlist")
    batch_p.add_argument("file_path")
    _add_filter_args(batch_p)

    # --- Download command ---
    download_p = subparsers.add_parser("download", help="Direct Download by MD5")
    download_p.add_argument("md5")

    # --- History command ---
    history_p = subparsers.add_parser("history", help="Show recent download history")
    history_p.add_argument(
        "-n", "--limit", type=int, default=20, help="Number of entries to show (default: 20)"
    )

    args = parser.parse_args()

    # Apply --config override before loading config
    if args.config:
        set_config_path(args.config)

    config = get_config()
    logger = setup_logging(verbose=args.verbose)

    active_db = config.get("db_path")
    active_out = config.get("out_dir", "downloads")
    active_proxies = config.get("proxies", [])
    active_concurrency = args.concurrency or config.get("concurrency", 2)
    active_concurrency = max(1, active_concurrency)
    history_db = config.get("history_db")  # None -> uses module default

    # Initialize download history table early
    init_downloads_table(history_db)

    # ------------------------------------------------------------------
    # Commands that don't need the network tool
    # ------------------------------------------------------------------
    if args.command == "history":
        print_download_history(history_db, limit=args.limit)
        return
    elif args.command == "diagnose":
        run_diagnostics(config)
        return

    # ------------------------------------------------------------------
    # Commands that need the network tool
    # ------------------------------------------------------------------
    try:
        strategy = create_strategy(args.strategy, proxies=active_proxies)
        tool = AnnasArchiveTool(
            proxies=active_proxies, direct_mode=args.direct, strategy=strategy
        )
    except ConnectionError as e:
        console.print(f"\n[bold red]HALT:[/bold red] {e}")
        sys.exit(1)

    try:
        _run_network_commands(args, tool, active_db, active_out, active_concurrency, history_db)
    finally:
        tool.close()


def _dict_to_tuple(d: dict) -> tuple:
    """Convert a scraper result dict to the 9-element tuple used by the download pipeline."""
    return (
        d.get("title", ""),
        d.get("author", ""),
        d.get("year", ""),
        d.get("extension", ""),
        d.get("md5", ""),
        d.get("language", ""),
        d.get("filesize_bytes", 0),
        d.get("publisher", ""),
        d.get("isbn13", ""),
    )


def _run_network_commands(
    args: argparse.Namespace,
    tool: AnnasArchiveTool,
    active_db: Optional[str],
    active_out: str,
    active_concurrency: int,
    history_db: Optional[str],
) -> None:
    """Execute commands that require the network tool."""
    logger = get_logger()

    if args.command == "search":
        filter_kwargs = _build_filter_kwargs(args)
        page = args.page
        results = scrape_annas_archive(
            args.query,
            ext=filter_kwargs.get("ext"),
            lang=filter_kwargs.get("lang"),
            page=page,
        )
        limit = getattr(args, "limit", None)
        if limit is not None:
            results = results[:limit]
        _print_live_results(results, page=page)

    elif args.command in ("batch-snatch", "snatch"):
        filter_kwargs = _build_filter_kwargs(args)
        targets: list[tuple] = []

        if args.command == "snatch":
            current_page = args.page

            while True:
                live_results = scrape_annas_archive(
                    args.query,
                    ext=filter_kwargs.get("ext"),
                    lang=filter_kwargs.get("lang"),
                    page=current_page,
                )
                if not live_results:
                    console.print("\n[yellow]No results found.[/yellow]")
                    return
                _print_live_results(live_results, page=current_page)

                # Build navigation hints
                nav_hints: list[str] = []
                if current_page > 1:
                    nav_hints.append("[bold yellow]P[/bold yellow]=Prev page")
                # Assume there's a next page if we got a full page of results
                SCRAPE_PAGE_SIZE = 20
                if len(live_results) >= SCRAPE_PAGE_SIZE:
                    nav_hints.append("[bold yellow]N[/bold yellow]=Next page")
                nav_hints.append("[bold yellow]Q[/bold yellow]=Quit")
                nav_line = "  ".join(nav_hints)

                choice = console.input(
                    f"\n[bold cyan]Select numbers (e.g. 1,3) or navigate ({nav_line}):[/bold cyan] "
                )
                choice_stripped = choice.strip().upper()

                if choice_stripped == "N" and len(live_results) >= SCRAPE_PAGE_SIZE:
                    current_page += 1
                    continue
                elif choice_stripped == "P" and current_page > 1:
                    current_page -= 1
                    continue
                elif choice_stripped == "Q":
                    return

                # Parse numeric selection (1-indexed into current page)
                try:
                    indices = [int(i.strip()) - 1 for i in choice.split(",")]
                    targets = [
                        _dict_to_tuple(live_results[i])
                        for i in indices
                        if 0 <= i < len(live_results)
                    ]
                except (ValueError, IndexError) as e:
                    logger.error(f"Invalid selection: {e}")
                    return
                break  # selection made, exit pagination loop

        else:  # batch-snatch
            with open(args.file_path, "r") as f:
                lines = [line.strip() for line in f if line.strip()]

            # Support MD5 hashes directly in the batch file
            md5_lines: List[str] = []
            query_lines: List[str] = []
            for line in lines:
                if MD5_LINE_PATTERN.match(line):
                    md5_lines.append(line)
                else:
                    query_lines.append(line)

            # Resolve MD5 hashes directly -- build a minimal tuple so the
            # download loop can extract md5 at index 4.
            for md5 in md5_lines:
                targets.append(("", "", "", "", md5, "", 0, "", ""))

            for q in query_lines:
                live_results = scrape_annas_archive(
                    q,
                    ext=filter_kwargs.get("ext"),
                    lang=filter_kwargs.get("lang"),
                )
                if live_results:
                    targets.append(_dict_to_tuple(live_results[0]))

        if targets:
            results = _run_concurrent_downloads(
                tool, targets, active_out, active_db, history_db, active_concurrency,
            )
            _print_summary_table(results)

    elif args.command == "fetch":
        dumps = tool.get_metadata_dumps()
        if dumps:
            latest = dumps[-1]
            console.print(f"\n[bold green]Latest dump:[/bold green] {latest.get('display_name', 'N/A')}")
            console.print(f"[bold blue]Magnet:[/bold blue] {latest.get('magnet_link', 'N/A')}")
        else:
            console.print("[yellow]No metadata dumps found.[/yellow]")

    elif args.command == "download":
        md5 = args.md5
        if not MD5_LINE_PATTERN.match(md5):
            console.print(
                "[bold red]Error:[/bold red] Invalid MD5 hash. "
                "Expected 32 hexadecimal characters."
            )
            sys.exit(1)
        # Single download also uses the concurrent infrastructure for consistency
        single_target = (None, None, None, None, md5)
        results = _run_concurrent_downloads(
            tool, [single_target], active_out, active_db, history_db, 1,
        )
        _print_summary_table(results)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        # Signal handler already printed the message; exit cleanly
        sys.exit(130)
    except Exception as e:
        get_logger().critical(f"FATAL: {e}", exc_info=True)
        sys.exit(1)
