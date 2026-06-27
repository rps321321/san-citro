"""Shared Anna's Archive scraper.

Centralises the search-page scraping logic so that both the FastAPI routes
and the Electron bridge handlers can reuse it without copy-pasting.

Returns plain dicts (no Pydantic dependency) so callers can convert to
whatever model they need.
"""

from __future__ import annotations

import logging
import random
import re
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import quote_plus, urlparse

import requests
from bs4 import BeautifulSoup

from .utils import attr_str, is_allowed_by_robots

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://annas-archive.gl"

# Rotate through a small pool of realistic User-Agent strings to reduce
# fingerprinting.  Each request picks one at random (Gap 4).
_USER_AGENTS: list[str] = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
]

# Per-request delay range (seconds) — adds jitter to avoid rate-limit patterns (Gap 2).
_DELAY_MIN = 0.5
_DELAY_MAX = 2.0

# Anna's Archive currently returns about 50 rows per search page.
SCRAPE_PAGE_SIZE = 50

_FILE_EXTENSIONS = {
    "azw3",
    "cb7",
    "cbr",
    "cbz",
    "djvu",
    "epub",
    "fb2",
    "mobi",
    "pdf",
    "txt",
}
_METADATA_SEPARATORS = re.compile(r"\s*(?:\xb7|\u2022|\|)\s*")
_LANGUAGE_TOKEN_RE = re.compile(r"^(.+?)\s*\[[a-z]{2,3}\]$", re.IGNORECASE)
_YEAR_RE = re.compile(r"\b(1[0-9]{3}|20[0-9]{2}|2100)\b")


def _pick_proxy(proxies: list[str]) -> str | None:
    """Return a random proxy URL from the list, or ``None`` if the list is empty."""
    return random.choice(proxies) if proxies else None


def _make_session(proxies: list[str]) -> tuple[requests.Session, str | None, str]:
    """Build a ``requests.Session`` with a random User-Agent and an optional proxy.

    Proxy rotation (Gap 1): picks a random entry from ``proxies`` for each session
    so consecutive requests don't always share the same egress IP.

    Returns the session along with the redacted proxy URL (or ``None``) and the
    chosen User-Agent so callers can report which egress was used.
    """
    session = requests.Session()

    user_agent = random.choice(_USER_AGENTS)
    session.headers.update(
        {
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Upgrade-Insecure-Requests": "1",
        }
    )

    proxy_url = _pick_proxy(proxies)
    redacted_proxy: str | None = None
    if proxy_url:
        session.proxies.update({"http": proxy_url, "https": proxy_url})
        redacted_proxy = proxy_url.split("@")[-1]  # redact credentials
        logger.debug("Using proxy: %s", redacted_proxy)

    return session, redacted_proxy, user_agent


# ---------------------------------------------------------------------------
# Gap 8: Static-vs-dynamic detection
# ---------------------------------------------------------------------------


def _verify_response_has_results(html: str) -> bool:
    """Check if the HTML actually contains search result elements.

    Returns ``True`` when the page contains known result markers
    (``href="/md5/"`` links or ``js-aarecord`` classes).  A ``False``
    return suggests the site may have switched to client-side rendering.
    """
    return 'href="/md5/' in html or "js-aarecord" in html


def parse_filesize(text: str) -> int | None:
    """Parse a human-readable size like ``'1.3MB'`` into bytes.

    Returns ``None`` when the string cannot be parsed.
    """
    match = re.search(r"([\d.]+)\s*(KB|MB|GB|TB|B)", text, re.IGNORECASE)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2).upper()
    multipliers = {
        "B": 1,
        "KB": 1024,
        "MB": 1024**2,
        "GB": 1024**3,
        "TB": 1024**4,
    }
    return int(value * multipliers.get(unit, 1))


def _metadata_tokens(card_lines: list[str]) -> list[str]:
    tokens: list[str] = []
    for line in card_lines:
        for part in _METADATA_SEPARATORS.split(line):
            token = part.strip(" \t\r\n,;")
            if token:
                tokens.append(token)
    return tokens


def _parse_card_metadata(card_lines: list[str]) -> tuple[str | None, str | None, int | None, str | None]:
    tokens = _metadata_tokens(card_lines)
    start = next(
        (
            i
            for i, token in enumerate(tokens)
            if _LANGUAGE_TOKEN_RE.match(token)
            or parse_filesize(token) is not None
            or token.lower().lstrip(".") in _FILE_EXTENSIONS
        ),
        None,
    )
    if start is None:
        return None, None, None, None

    language: str | None = None
    extension: str | None = None
    filesize_bytes: int | None = None
    year: str | None = None

    for token in tokens[start : start + 8]:
        if language is None:
            lang_match = _LANGUAGE_TOKEN_RE.match(token)
            if lang_match:
                language = lang_match.group(1).strip()

        if extension is None:
            candidate_ext = token.lower().lstrip(".")
            if candidate_ext in _FILE_EXTENSIONS:
                extension = candidate_ext

        if filesize_bytes is None:
            filesize_bytes = parse_filesize(token)

        if year is None:
            year_match = _YEAR_RE.search(token)
            if year_match:
                year = year_match.group(1)

    return language, extension, filesize_bytes, year


def scrape_annas_archive(
    query: str,
    *,
    ext: str | None = None,
    lang: str | None = None,
    page: int = 1,
    base_url: str = _DEFAULT_BASE_URL,
    seen_md5s: set[str] | None = None,
    proxies: list[str] | None = None,
    on_health: Callable[[dict], None] | None = None,
) -> list[dict[str, Any]]:
    """Scrape an Anna's Archive search-results page and return book metadata.

    Parameters
    ----------
    query:
        The search string.
    ext:
        Optional file-extension filter (e.g. ``"epub"``).
    lang:
        Optional language-code filter (e.g. ``"en"``).
    page:
        1-based page number.
    base_url:
        Anna's Archive domain to query.  Useful for domain fallback.
    seen_md5s:
        Optional mutable set for cross-page deduplication (Gap 13).
        When provided, MD5 hashes found on earlier pages are skipped and
        new hashes are added in-place.  Pass the same set across
        consecutive calls to deduplicate across pages.
    proxies:
        List of proxy URLs (e.g. ``["http://host:port"]``).  A random one
        is selected per request (Gap 1 rotation).  When omitted, the
        config is read automatically.
    on_health:
        Optional sink invoked exactly once per call with a dict describing the
        request health (domain, status_code, response_time_ms, success, blocked,
        proxy_used, user_agent, error_message).  Callback errors are swallowed
        so they never break scraping.  When omitted, no health is reported.

    Returns
    -------
    list[dict[str, Any]]
        Each dict contains: ``title``, ``author``, ``year``, ``extension``,
        ``md5``, ``language``, ``filesize_bytes``, ``publisher``, ``isbn13``,
        ``is_downloaded``.

    Raises
    ------
    RuntimeError
        When the HTTP request to Anna's Archive fails.
    """
    if seen_md5s is None:
        seen_md5s = set()

    # Load proxies from config if not supplied by the caller (Gap 1)
    if proxies is None:
        try:
            from .config_manager import get_config

            proxies = get_config().get("proxies") or []
        except Exception:
            proxies = []

    params = f"q={quote_plus(query)}"
    if ext:
        params += f"&ext={quote_plus(ext)}"
    if lang:
        params += f"&lang={quote_plus(lang)}"
    if page > 1:
        params += f"&page={page}"

    url = f"{base_url.rstrip('/')}/search?{params}"

    # Gap 14: robots.txt awareness (warn-only, does not block)
    is_allowed_by_robots(url, user_agent=_USER_AGENTS[0])

    # Gap 2: random delay with jitter before each request
    delay = random.uniform(_DELAY_MIN, _DELAY_MAX)
    logger.debug("Scraper sleeping %.2fs before request", delay)
    time.sleep(delay)

    session, proxy_used, user_agent = _make_session(proxies)
    domain = urlparse(base_url).netloc

    def _emit_health(health: dict[str, Any]) -> None:
        if on_health is None:
            return
        try:
            on_health(health)
        except Exception:  # health reporting must never break scraping
            logger.debug("on_health callback raised", exc_info=True)

    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        status_code = getattr(exc.response, "status_code", None)
        _emit_health(
            {
                "domain": domain,
                "status_code": status_code,
                "response_time_ms": None,
                "success": False,
                "blocked": status_code in (403, 429),
                "proxy_used": proxy_used,
                "user_agent": user_agent,
                "error_message": str(exc)[:500],
            }
        )
        logger.error("Failed to reach Anna's Archive: %s", exc)
        raise RuntimeError(f"Failed to reach Anna's Archive: {exc}") from exc

    _emit_health(
        {
            "domain": domain,
            "status_code": resp.status_code,
            "response_time_ms": int(resp.elapsed.total_seconds() * 1000),
            "success": True,
            "blocked": not _verify_response_has_results(resp.text),
            "proxy_used": proxy_used,
            "user_agent": user_agent,
            "error_message": None,
        }
    )

    # Gap 8: verify the response contains expected result markers
    if not _verify_response_has_results(resp.text):
        logger.warning(
            "Response HTML does not contain expected search result markers "
            "-- site may have switched to client-side rendering"
        )

    soup = BeautifulSoup(resp.text, "html.parser")
    results: list[dict[str, Any]] = []

    for link in soup.select('a[href*="/md5/"]'):
        try:
            href = attr_str(link.get("href")) or ""
            md5_match = re.search(r"/md5/([a-f0-9]{32})", href)
            if not md5_match:
                continue
            md5 = md5_match.group(1)
            if md5 in seen_md5s:
                continue
            title = link.get_text(strip=True)
            if not title:
                continue
            seen_md5s.add(md5)

            # Walk up to the result card (div with border-b class)
            container = link.parent
            for _ in range(4):
                parent = container.parent if container else None
                if not parent or parent.name == "body":
                    break
                class_attr = parent.get("class")
                parent_classes = " ".join(class_attr) if isinstance(class_attr, list) else ""
                if "border-b" in parent_classes:
                    container = parent
                    break
                container = parent

            card_text = container.get_text(separator="\n", strip=True) if container else ""
            card_lines = [ln.strip() for ln in card_text.split("\n") if ln.strip()]

            author: str | None = None
            year: str | None = None
            extension: str | None = None
            language: str | None = None
            filesize_bytes: int | None = None
            publisher: str | None = None

            language, extension, filesize_bytes, year = _parse_card_metadata(card_lines)

            # Find author — typically the line right after the title
            title_idx: int | None = None
            for i, line in enumerate(card_lines):
                if title in line or line in title:
                    title_idx = i
                    break

            if title_idx is not None:
                for line in card_lines[title_idx + 1 : title_idx + 5]:
                    if re.search(
                        r"\[\w+\]\s*\xb7|upload/|lgli/|nexusstc/|zlib/|base score",
                        line,
                    ):
                        continue
                    if re.search(r"<[a-z]|Read more", line, re.IGNORECASE):
                        continue
                    if len(line) > 3 and (line in title or title in line):
                        continue
                    if len(line) > 3 and len(line) < 120:
                        pub_match = re.search(r"^(.+?),\s*.*?(\d{4})\s*$", line)
                        if pub_match:
                            publisher = pub_match.group(1).strip()
                            if not year:
                                year = pub_match.group(2)
                        else:
                            author = line
                        break

            # Extract cover image URL from the card's <img> tag
            cover_url: str | None = None
            if container:
                img = container.select_one("img")
                if img:
                    src = attr_str(img.get("src")) or attr_str(img.get("data-src")) or ""
                    if src and not src.endswith("placeholder") and len(src) > 10:
                        cover_url = src if src.startswith("http") else None

            results.append(
                {
                    "title": title[:200],
                    "author": author,
                    "year": year,
                    "extension": extension,
                    "md5": md5,
                    "language": language,
                    "filesize_bytes": filesize_bytes,
                    "publisher": publisher,
                    "isbn13": None,
                    "cover_url": cover_url,
                    "is_downloaded": False,
                }
            )
        except Exception:
            continue

    return results
