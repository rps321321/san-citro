import math
import sqlite3
import os
from dataclasses import dataclass, field
from typing import Optional, List, Tuple, Dict, Any, Set
import requests
from rich.console import Console
from rich.table import Table
from rich import box
from rich.panel import Panel
from .logger import get_logger

logger = get_logger()
console = Console()


@dataclass
class SearchResult:
    """Container for paginated search results."""
    results: List[Tuple] = field(default_factory=list)
    total_count: int = 0
    page: int = 1
    per_page: int = 10

    @property
    def total_pages(self) -> int:
        return max(1, math.ceil(self.total_count / self.per_page))

    @property
    def has_next(self) -> bool:
        return self.page < self.total_pages

    @property
    def has_prev(self) -> bool:
        return self.page > 1


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
    page: int = 1,
    per_page: Optional[int] = None,
) -> SearchResult:
    """Searches the local database with advanced filters and pagination.

    Args:
        db_path: Path to the SQLite database.
        query: Search query string.
        limit: Maximum results (used as per_page default when per_page is None).
        ext: Filter by file extension.
        lang: Filter by language code.
        after: Filter by minimum year.
        download_dir: Path to download directory for ownership checks.
        page: Page number (1-indexed).
        per_page: Results per page. Falls back to ``limit`` when not provided.

    Returns:
        SearchResult with paginated rows, total count, and page metadata.
    """
    effective_per_page = per_page if per_page is not None else limit
    page = max(1, page)
    offset = (page - 1) * effective_per_page

    if not db_path or not os.path.exists(db_path):
        logger.error(f"Database not found: {db_path}")
        return SearchResult(page=page, per_page=effective_per_page)

    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()

        # --- Build WHERE clause shared by count and data queries ---
        where_clause = "WHERE records_fts MATCH ?"
        params: List[Any] = [_sanitize_fts_query(query)]
        filter_clauses: List[str] = []
        filter_params: List[Any] = []

        if ext:
            filter_clauses.append("r.extension = ?")
            filter_params.append(ext.lower())
        if lang:
            filter_clauses.append("r.language = ?")
            filter_params.append(lang.lower())
        if after:
            filter_clauses.append("r.year >= ?")
            filter_params.append(str(after))

        extra_where = ""
        if filter_clauses:
            extra_where = " AND " + " AND ".join(filter_clauses)

        # --- Count query ---
        count_sql = (
            "SELECT COUNT(*) FROM records r "
            "JOIN records_fts f ON r.md5 = f.md5 "
            f"{where_clause}{extra_where}"
        )
        count_params = params + filter_params

        # --- Data query ---
        data_sql = (
            "SELECT r.title, r.author, r.year, r.extension, r.md5, r.language, "
            "r.filesize_bytes, r.publisher, r.isbn13 "
            "FROM records r "
            "JOIN records_fts f ON r.md5 = f.md5 "
            f"{where_clause}{extra_where} "
            "ORDER BY rank LIMIT ? OFFSET ?"
        )
        data_params = params + filter_params + [effective_per_page, offset]

        try:
            cursor.execute(count_sql, count_params)
            total_count = cursor.fetchone()[0]

            cursor.execute(data_sql, data_params)
            results = cursor.fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(f"FTS5 search failed, falling back to LIKE: {e}")
            search_term = f"%{query}%"

            fb_where = "WHERE (title LIKE ? OR author LIKE ?)"
            fb_params: List[Any] = [search_term, search_term]
            fb_filter = ""
            fb_filter_params: List[Any] = []
            if ext:
                fb_filter += " AND extension = ?"
                fb_filter_params.append(ext.lower())
            if lang:
                fb_filter += " AND language = ?"
                fb_filter_params.append(lang.lower())

            count_fb_sql = f"SELECT COUNT(*) FROM records {fb_where}{fb_filter}"
            cursor.execute(count_fb_sql, fb_params + fb_filter_params)
            total_count = cursor.fetchone()[0]

            data_fb_sql = (
                "SELECT title, author, year, extension, md5, language, "
                f"filesize_bytes, publisher, isbn13 FROM records {fb_where}{fb_filter} "
                "LIMIT ? OFFSET ?"
            )
            cursor.execute(data_fb_sql, fb_params + fb_filter_params + [effective_per_page, offset])
            results = cursor.fetchall()

    return SearchResult(
        results=results,
        total_count=total_count,
        page=page,
        per_page=effective_per_page,
    )


def print_results(
    search_result: SearchResult,
    download_dir: str = "downloads",
    enrich: bool = False,
) -> None:
    """Display results in a professional Rich table with pagination info.

    Accepts either a ``SearchResult`` instance (preferred) or a plain list
    of tuples for backward compatibility.
    """
    # Backward compatibility: accept a bare list
    if isinstance(search_result, list):
        search_result = SearchResult(results=search_result, total_count=len(search_result))

    if not search_result.results:
        console.print("\n[yellow]No results found.[/yellow]")
        return

    # Build ownership set once instead of scanning per-result
    owned_files: Set[str] = set()
    if os.path.exists(download_dir):
        owned_files = set(os.listdir(download_dir))

    # Row numbering accounts for page offset
    start_num = (search_result.page - 1) * search_result.per_page

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

    for idx, row in enumerate(search_result.results, start_num + 1):
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

    # Pagination footer
    if search_result.total_count > 0:
        console.print(
            f"\n[bold]Page {search_result.page} of {search_result.total_pages} "
            f"({search_result.total_count} total)[/bold]"
        )
