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
from typing import Any
from urllib.parse import quote_plus

import requests
from bs4 import BeautifulSoup

from .utils import attr_str, is_allowed_by_robots

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


def _pick_proxy(proxies: list[str]) -> str | None:
    """Return a random proxy URL from the list, or ``None`` if the list is empty."""
    return random.choice(proxies) if proxies else None


def _make_session(proxies: list[str]) -> requests.Session:
    """Build a ``requests.Session`` with a random User-Agent and an optional proxy.

    Proxy rotation (Gap 1): picks a random entry from ``proxies`` for each session
    so consecutive requests don't always share the same egress IP.
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
    if proxy_url:
        session.proxies.update({"http": proxy_url, "https": proxy_url})
        logger.debug("Using proxy: %s", proxy_url.split("@")[-1])  # redact credentials

    return session


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


def scrape_annas_archive(
    query: str,
    *,
    ext: str | None = None,
    lang: str | None = None,
    page: int = 1,
    base_url: str = _DEFAULT_BASE_URL,
    seen_md5s: set[str] | None = None,
    proxies: list[str] | None = None,
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

    session = _make_session(proxies)

    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.error("Failed to reach Anna's Archive: %s", exc)
        raise RuntimeError(f"Failed to reach Anna's Archive: {exc}") from exc

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

            # Metadata line: "English [en] · EPUB · 3.2MB · 2011 · Book"
            for line in card_lines:
                meta_match = re.match(
                    r"(\w[\w\s]*?)\s*\[\w+\]\s*\xb7\s*(\w+)\s*\xb7\s*" r"([\d.]+\s*[KMGT]?B)\s*\xb7\s*(\d{4})",
                    line,
                )
                if meta_match:
                    language = meta_match.group(1).strip()
                    extension = meta_match.group(2).lower()
                    filesize_bytes = parse_filesize(meta_match.group(3))
                    year = meta_match.group(4)
                    break

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
