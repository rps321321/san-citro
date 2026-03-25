"""Export utilities for search results.

Supports table (Rich), JSON, and CSV output formats.
Each exporter writes to a file handle or stdout by default.
"""
import csv
import io
import json
import os
import sys
from typing import List, Tuple, Optional, Set, TextIO

from rich.console import Console
from rich.table import Table
from rich import box


# Column definitions matching the tuple layout from search_db:
# (title, author, year, extension, md5, language, filesize_bytes, publisher, isbn13)
FIELD_NAMES = [
    "title",
    "author",
    "year",
    "extension",
    "md5",
    "language",
    "filesize_bytes",
    "publisher",
    "isbn13",
]


def _format_size(size: Optional[int]) -> str:
    """Convert byte count to human-readable string."""
    if size and size > 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size:
        return f"{size / 1024:.1f} KB"
    return "N/A"


def _build_owned_set(download_dir: str) -> Set[str]:
    """Build a set of filenames in the download directory for ownership checks."""
    if download_dir and os.path.exists(download_dir):
        return set(os.listdir(download_dir))
    return set()


def _is_owned(md5: str, owned_files: Set[str]) -> bool:
    """Check whether any file in the download dir contains this MD5."""
    return any(md5 in fname for fname in owned_files)


def export_table(
    results: List[Tuple],
    file: Optional[str] = None,
    download_dir: str = "downloads",
) -> None:
    """Render results as a Rich table to the console or a file.

    When *file* is provided the table is rendered with no colour markup
    so the plain-text version is written to disk.
    """
    if not results:
        Console().print("\n[yellow]No results found.[/yellow]")
        return

    owned_files = _build_owned_set(download_dir)

    table = Table(
        title="Archive Search Results",
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
    table.add_column("Status", justify="center")

    for idx, row in enumerate(results, 1):
        title, author, year, ext, md5, lang, size, pub, isbn = row
        status = (
            "[bold green]OWNED[/bold green]"
            if _is_owned(md5, owned_files)
            else "[red]Missing[/red]"
        )
        table.add_row(
            str(idx),
            title,
            author or "Unknown",
            str(year) if year else "N/A",
            ext.upper() if ext else "N/A",
            _format_size(size),
            status,
        )

    if file:
        plain_console = Console(file=open(file, "w", encoding="utf-8"), force_terminal=False)
        plain_console.print(table)
        # flush and close the underlying file handle
        plain_console.file.close()
    else:
        Console().print(table)


def export_json(
    results: List[Tuple],
    file: Optional[str] = None,
    download_dir: str = "downloads",
) -> str:
    """Serialize results to a JSON array.

    Returns the JSON string.  When *file* is given, also writes to disk.
    """
    owned_files = _build_owned_set(download_dir)
    records = []
    for row in results:
        title, author, year, ext, md5, lang, size, pub, isbn = row
        records.append({
            "title": title,
            "author": author or "Unknown",
            "year": int(year) if year else None,
            "extension": ext,
            "md5": md5,
            "language": lang,
            "filesize_bytes": size,
            "size_human": _format_size(size),
            "publisher": pub,
            "isbn13": isbn,
            "owned": _is_owned(md5, owned_files),
        })

    output = json.dumps(records, indent=2, ensure_ascii=False)

    if file:
        with open(file, "w", encoding="utf-8") as fh:
            fh.write(output)
    else:
        print(output)

    return output


def export_csv(
    results: List[Tuple],
    file: Optional[str] = None,
    download_dir: str = "downloads",
) -> str:
    """Write results as CSV with headers.

    Returns the CSV string.  When *file* is given, also writes to disk.
    """
    owned_files = _build_owned_set(download_dir)
    headers = [
        "title",
        "author",
        "year",
        "extension",
        "md5",
        "language",
        "filesize_bytes",
        "size_human",
        "publisher",
        "isbn13",
        "owned",
    ]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)

    for row in results:
        title, author, year, ext, md5, lang, size, pub, isbn = row
        writer.writerow([
            title,
            author or "Unknown",
            int(year) if year else "",
            ext,
            md5,
            lang,
            size or "",
            _format_size(size),
            pub or "",
            isbn or "",
            _is_owned(md5, owned_files),
        ])

    output = buf.getvalue()
    buf.close()

    if file:
        with open(file, "w", encoding="utf-8", newline="") as fh:
            fh.write(output)
    else:
        print(output, end="")

    return output
