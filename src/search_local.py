import sqlite3
import os
from typing import Optional, List, Tuple, Dict, Any, Set
import requests
from rich.console import Console
from rich.table import Table
from rich import box
from rich.panel import Panel
from logger import get_logger

logger = get_logger()
console = Console()


def get_external_metadata(isbn: str) -> Optional[Dict[str, Any]]:
    """Fetches high-res cover and page count from OpenLibrary API."""
    if not isbn or isbn == "N/A":
        return None
    try:
        url = f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data"
        res = requests.get(url, timeout=5, verify=True)
        data = res.json()
        book_key = f"ISBN:{isbn}"
        if book_key in data:
            b = data[book_key]
            return {
                "pages": b.get("number_of_pages", "N/A"),
                "cover": b.get("cover", {}).get("medium", None),
                "url": b.get("url", None),
            }
    except requests.RequestException as e:
        logger.debug(f"OpenLibrary API call failed for ISBN {isbn}: {e}")
    except (ValueError, KeyError) as e:
        logger.debug(f"Malformed OpenLibrary response for ISBN {isbn}: {e}")
    return None


def _sanitize_fts_query(query: str) -> str:
    """Wrap query in double-quotes to force literal FTS5 matching and prevent query injection."""
    # Remove any existing double-quotes to prevent syntax manipulation
    sanitized = query.replace('"', "")
    return f'"{sanitized}"'


def search_db(
    db_path: str,
    query: str,
    limit: int = 10,
    ext: Optional[str] = None,
    lang: Optional[str] = None,
    after: Optional[int] = None,
    download_dir: str = "downloads",
) -> List[Tuple]:
    """Searches the local database with advanced filters and returns results."""
    if not db_path or not os.path.exists(db_path):
        logger.error(f"Database not found: {db_path}")
        return []

    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()

        sql = """
            SELECT
                r.title, r.author, r.year, r.extension, r.md5, r.language,
                r.filesize_bytes, r.publisher, r.isbn13
            FROM records r
            JOIN records_fts f ON r.md5 = f.md5
            WHERE records_fts MATCH ?
        """
        params: List[Any] = [_sanitize_fts_query(query)]

        if ext:
            sql += " AND r.extension = ?"
            params.append(ext.lower())
        if lang:
            sql += " AND r.language = ?"
            params.append(lang.lower())
        if after:
            sql += " AND r.year >= ?"
            params.append(str(after))

        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        try:
            cursor.execute(sql, params)
            results = cursor.fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(f"FTS5 search failed, falling back to LIKE: {e}")
            search_term = f"%{query}%"
            sql_fallback = (
                "SELECT title, author, year, extension, md5, language, "
                "filesize_bytes, publisher, isbn13 FROM records "
                "WHERE (title LIKE ? OR author LIKE ?)"
            )
            fallback_params: List[Any] = [search_term, search_term]
            if ext:
                sql_fallback += " AND extension = ?"
                fallback_params.append(ext.lower())
            if lang:
                sql_fallback += " AND language = ?"
                fallback_params.append(lang.lower())
            sql_fallback += " LIMIT ?"
            fallback_params.append(limit)
            cursor.execute(sql_fallback, fallback_params)
            results = cursor.fetchall()

    return results


def print_results(
    results: List[Tuple],
    download_dir: str = "downloads",
    enrich: bool = False,
) -> None:
    """Utility to display results in a professional Rich table."""
    if not results:
        console.print("\n[yellow]No results found.[/yellow]")
        return

    # Build ownership set once instead of scanning per-result
    owned_files: Set[str] = set()
    if os.path.exists(download_dir):
        owned_files = set(os.listdir(download_dir))

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
    table.add_column("Pages", justify="center", style="dim")
    table.add_column("Status", justify="center")

    for idx, row in enumerate(results, 1):
        title, author, year, ext, md5, lang, size, pub, isbn = row

        # Enrichment logic
        pages = "N/A"
        if enrich and isbn:
            ext_data = get_external_metadata(isbn)
            if ext_data:
                pages = str(ext_data["pages"])

        # Check ownership via pre-built set
        status = "[red]Missing[/red]"
        for fname in owned_files:
            if md5 in fname:
                status = "[bold green]OWNED[/bold green]"
                break

        if size and size > 1024 * 1024:
            size_str = f"{size / (1024 * 1024):.1f} MB"
        elif size:
            size_str = f"{size / 1024:.1f} KB"
        else:
            size_str = "N/A"

        table.add_row(
            str(idx),
            title,
            author or "Unknown",
            str(year) if year else "N/A",
            ext.upper() if ext else "N/A",
            size_str,
            pages,
            status,
        )

    console.print(table)
