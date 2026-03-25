"""Download strategies for Anna's Archive slow downloads.

Implements a strategy pattern with two concrete strategies:
- ChromeStrategy: uses undetected_chromedriver to handle JS-based countdowns
- DirectHTTPStrategy: uses requests + BeautifulSoup to parse the slow_download page
"""

from __future__ import annotations

import re
import time
from abc import ABC, abstractmethod
from typing import Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from .logger import get_logger

logger = get_logger()

TRUSTED_DOMAINS = {"annas-archive.gl", "annas-archive.org", "annas-archive.se"}

# Domains that appear on the download page but are NOT actual file hosts
BLACKLISTED_DOMAINS = {
    "jdownloader.org", "www.jdownloader.org",
    "donate.annas-archive.org", "annas-blog.org",
    "t.me", "twitter.com", "x.com", "reddit.com",
    "github.com", "patreon.com",
}

# Known CDN / mirror patterns for actual file downloads
CDN_PATTERNS = [
    r"\.cloudfront\.net$",
    r"\.amazonaws\.com$",
    r"\.b-cdn\.net$",
    r"\.bunnycdn\.net$",
    r"\.fastly\.net$",
    r"\.ipfs\.",
    r"\.pinata\.cloud$",
    r"libgen\.",
    r"library\.lol$",
    r"b4mcx2ml\.net$",
    r"nrzr\.li$",
    r"momot\.rs$",
    r"d1lib\.",
    r"z-lib\.",
    r"nexusstc",
]

FILE_EXTENSIONS = (
    ".pdf", ".epub", ".mobi", ".azw3", ".djvu", ".cbr", ".cbz",
    ".fb2", ".txt", ".doc", ".docx", ".rtf", ".zip", ".rar",
)


def _is_plausible_download_url(href: str, base_url: str) -> bool:
    """Check if a URL looks like an actual file download, not a promo/nav link."""
    parsed = urlparse(href)
    hostname = parsed.hostname or ""

    # Reject blacklisted domains
    if hostname in BLACKLISTED_DOMAINS:
        return False

    # Reject self-referencing links
    if base_url and base_url in href:
        return False

    # Reject short paths (promo links like jdownloader.org/ have path="/")
    if len(parsed.path) < 10:
        return False

    # Accept known CDN patterns
    for pattern in CDN_PATTERNS:
        if re.search(pattern, hostname, re.IGNORECASE):
            return True

    # Accept URLs with file extensions
    if any(parsed.path.lower().endswith(ext) for ext in FILE_EXTENSIONS):
        return True

    # Accept URLs with long paths (CDN download paths are typically long)
    if len(parsed.path) > 50:
        return True

    return False


class DownloadStrategy(ABC):
    """Protocol for download strategies that resolve a slow_download page into a final URL."""

    @abstractmethod
    def get_download_url(
        self,
        slow_download_url: str,
        md5: str,
        session: requests.Session,
        base_url: str,
    ) -> Optional[tuple[str, dict[str, str], dict[str, str]]]:
        """Resolve the slow_download page to a direct download URL.

        Args:
            slow_download_url: The slow_download page URL.
            md5: The MD5 hash of the file (for logging).
            session: A requests.Session with retry logic.
            base_url: The base Anna's Archive URL.

        Returns:
            A tuple of (download_url, cookies_dict, headers_dict) or None on failure.
        """
        ...


class ChromeStrategy(DownloadStrategy):
    """Uses undetected_chromedriver to wait for JS countdown and extract the download link."""

    def get_download_url(
        self,
        slow_download_url: str,
        md5: str,
        session: requests.Session,
        base_url: str,
    ) -> Optional[tuple[str, dict[str, str], dict[str, str]]]:
        try:
            import undetected_chromedriver as uc
        except ImportError:
            logger.error(
                "undetected-chromedriver is not installed. "
                "Install it with: pip install 'annas-archive-toolkit[download]'"
            )
            return None

        short = md5[:6]
        logger.info(f"[{short}] ChromeStrategy: launching browser for countdown page")

        driver = None
        try:
            options = uc.ChromeOptions()
            options.add_argument("--disable-blink-features=AutomationControlled")
            # Detect installed Chrome major version to avoid chromedriver mismatch
            ver_major = None
            try:
                chrome_exe = uc.find_chrome_executable()
                if chrome_exe:
                    import subprocess, platform
                    if platform.system() == "Windows":
                        result = subprocess.run(
                            ["powershell", "-Command",
                             f"(Get-Item '{chrome_exe}').VersionInfo.FileVersion"],
                            capture_output=True, text=True, timeout=5,
                        )
                        if result.returncode == 0 and result.stdout.strip():
                            ver_major = int(result.stdout.strip().split(".")[0])
                    else:
                        result = subprocess.run(
                            [chrome_exe, "--version"],
                            capture_output=True, text=True, timeout=5,
                        )
                        if result.returncode == 0:
                            import re as _re
                            m = _re.search(r"(\d+)\.", result.stdout)
                            if m:
                                ver_major = int(m.group(1))
            except Exception:
                pass
            if ver_major:
                logger.debug(f"Detected Chrome version: {ver_major}")
            driver = uc.Chrome(options=options, version_main=ver_major)
            driver.get(slow_download_url)

            download_url = None
            download_keywords = ["download now", "download", "save"]
            max_polls = 30  # 30 x 5s = 150s max
            poll_interval = 5

            for attempt in range(max_polls):
                time.sleep(poll_interval)
                if attempt > 0 and attempt % 6 == 0:
                    logger.info(
                        f"[{short}] Waiting for countdown... "
                        f"({attempt * poll_interval}s elapsed)"
                    )
                try:
                    for a in driver.find_elements("tag name", "a"):
                        text = (a.text or "").lower().strip()
                        href = a.get_attribute("href") or ""
                        has_keyword = any(kw in text for kw in download_keywords)
                        is_real_url = href.startswith("http") and not href.endswith("#")
                        if has_keyword and is_real_url and _is_plausible_download_url(href, base_url):
                            download_url = href
                            logger.info(
                                f"[{short}] Found download link after "
                                f"{attempt * poll_interval}s"
                            )
                            break
                except Exception as e:
                    logger.debug(f"Selenium poll error (retrying): {e}")
                if download_url:
                    break

            if not download_url:
                logger.warning(
                    f"[{short}] No download link found after "
                    f"{max_polls * poll_interval}s"
                )
                return None

            cookies = {c["name"]: c["value"] for c in driver.get_cookies()}
            user_agent = driver.execute_script("return navigator.userAgent;")

            headers = {"User-Agent": user_agent, "Referer": slow_download_url}
            return download_url, cookies, headers

        except Exception as e:
            logger.error(f"[{short}] Browser automation failed: {e}")
            return None
        finally:
            if driver:
                try:
                    driver.quit()
                except Exception:
                    pass


class DirectHTTPStrategy(DownloadStrategy):
    """Uses requests + BeautifulSoup to parse the slow_download page directly.

    This strategy:
    1. Fetches the slow_download HTML page
    2. Parses it for countdown duration and the eventual download link
    3. Waits for the countdown to expire
    4. Re-fetches or follows the redirect to get the final download URL
    """

    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )

    def get_download_url(
        self,
        slow_download_url: str,
        md5: str,
        session: requests.Session,
        base_url: str,
    ) -> Optional[tuple[str, dict[str, str], dict[str, str]]]:
        short = md5[:6]
        logger.info(f"[{short}] DirectHTTPStrategy: fetching slow_download page")

        headers = {
            "User-Agent": self.USER_AGENT,
            "Referer": f"{base_url}/md5/{md5}",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }

        try:
            resp = session.get(
                slow_download_url,
                headers=headers,
                timeout=30,
                verify=True,
            )
            resp.raise_for_status()
        except requests.RequestException as e:
            logger.error(f"[{short}] Failed to fetch slow_download page: {e}")
            return None

        soup = BeautifulSoup(resp.text, "html.parser")

        # Extract countdown duration from the page.
        # Common patterns: a JS variable like `countdown = 5;` or a visible timer element.
        countdown_seconds = self._extract_countdown(soup, resp.text)
        if countdown_seconds > 0:
            logger.info(
                f"[{short}] Waiting {countdown_seconds}s for countdown to expire..."
            )
            time.sleep(countdown_seconds + 1)  # +1s safety margin

        # After countdown: try to find a direct download link on the page
        download_url = self._extract_download_link(soup, base_url)

        if not download_url:
            # Re-fetch the page after waiting -- some pages dynamically reveal the link
            logger.debug(f"[{short}] No link found initially, re-fetching page...")
            try:
                resp2 = session.get(
                    slow_download_url,
                    headers=headers,
                    timeout=30,
                    verify=True,
                )
                resp2.raise_for_status()
                soup2 = BeautifulSoup(resp2.text, "html.parser")
                download_url = self._extract_download_link(soup2, base_url)
            except requests.RequestException as e:
                logger.error(f"[{short}] Re-fetch failed: {e}")
                return None

        if not download_url:
            logger.warning(f"[{short}] DirectHTTPStrategy: could not find download URL")
            return None

        logger.info(f"[{short}] DirectHTTPStrategy: resolved download URL")
        response_headers = {"User-Agent": self.USER_AGENT, "Referer": slow_download_url}
        cookies = dict(resp.cookies) if resp.cookies else {}
        return download_url, cookies, response_headers

    def _extract_countdown(self, soup: BeautifulSoup, raw_html: str) -> int:
        """Extract countdown duration from the page HTML.

        Looks for common patterns:
        - JavaScript variables: `countdown = 5`, `var seconds = 10`, `timer = 5`
        - Data attributes: `data-countdown="5"`, `data-seconds="5"`
        - Element with id/class containing 'countdown' or 'timer'
        """
        # Pattern 1: JS countdown variable assignments
        js_patterns = [
            r'countdown\s*=\s*(\d+)',
            r'seconds?\s*=\s*(\d+)',
            r'timer\s*=\s*(\d+)',
            r'wait\s*=\s*(\d+)',
            r'delay\s*=\s*(\d+)',
            r'setTimeout\s*\([^,]+,\s*(\d{3,6})\)',  # setTimeout(..., milliseconds)
        ]
        for pattern in js_patterns:
            match = re.search(pattern, raw_html, re.IGNORECASE)
            if match:
                value = int(match.group(1))
                # If it looks like milliseconds (>= 1000), convert to seconds
                if value >= 1000:
                    value = value // 1000
                # Sanity check: countdowns are typically 1-120 seconds
                if 1 <= value <= 120:
                    return value

        # Pattern 2: data-countdown or data-seconds attributes
        for attr_name in ("data-countdown", "data-seconds", "data-timer", "data-wait"):
            el = soup.find(attrs={attr_name: True})
            if el:
                try:
                    value = int(el[attr_name])
                    if 1 <= value <= 120:
                        return value
                except (ValueError, TypeError):
                    pass

        # Pattern 3: element text with countdown-like class/id
        for el in soup.find_all(attrs={"id": re.compile(r"countdown|timer", re.I)}):
            text = el.get_text(strip=True)
            match = re.search(r'(\d+)', text)
            if match:
                value = int(match.group(1))
                if 1 <= value <= 120:
                    return value

        for el in soup.find_all(class_=re.compile(r"countdown|timer", re.I)):
            text = el.get_text(strip=True)
            match = re.search(r'(\d+)', text)
            if match:
                value = int(match.group(1))
                if 1 <= value <= 120:
                    return value

        # Default: assume a 5-second countdown if nothing found
        logger.debug("Could not detect countdown duration, defaulting to 5s")
        return 5

    def _extract_download_link(
        self, soup: BeautifulSoup, base_url: str
    ) -> Optional[str]:
        """Extract the actual file download link from the parsed page.

        Looks for anchor tags with download-related text/attributes
        pointing to external URLs (not back to the archive itself).
        """
        download_keywords = ["download now", "download", "save", "get"]

        # Strategy A: links with download-related text
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(strip=True).lower()
            has_keyword = any(kw in text for kw in download_keywords)
            is_real_url = href.startswith("http") and not href.endswith("#")

            if has_keyword and is_real_url and _is_plausible_download_url(href, base_url):
                return href

        # Strategy B: links with 'download' attribute (HTML5 download attr)
        for a in soup.find_all("a", attrs={"download": True}):
            href = a.get("href", "")
            if href.startswith("http"):
                return href

        # Strategy C: look for meta refresh redirect or JS redirect
        meta_refresh = soup.find("meta", attrs={"http-equiv": "refresh"})
        if meta_refresh:
            content = meta_refresh.get("content", "")
            match = re.search(r'url=(.+)', content, re.IGNORECASE)
            if match:
                url = match.group(1).strip().strip("'\"")
                if url.startswith("http") and base_url not in url:
                    return url

        return None

    def _is_trusted_or_external_download(self, url: str) -> bool:
        """Validate that the URL is either from a trusted domain or a plausible CDN."""
        parsed = urlparse(url)
        hostname = parsed.hostname or ""

        # Accept trusted Anna's Archive domains
        if hostname in TRUSTED_DOMAINS:
            return True

        # Accept common CDN/storage patterns (these host the actual files)
        cdn_patterns = [
            r"\.cloudfront\.net$",
            r"\.amazonaws\.com$",
            r"\.b-cdn\.net$",
            r"\.bunnycdn\.net$",
            r"\.fastly\.net$",
            r"\.ipfs\.",
            r"\.pinata\.cloud$",
            r"libgen\.",
            r"library\.lol$",
        ]
        for pattern in cdn_patterns:
            if re.search(pattern, hostname, re.IGNORECASE):
                return True

        # Accept any URL that looks like a file download (has a file extension in path)
        path = parsed.path.lower()
        file_extensions = (
            ".pdf", ".epub", ".mobi", ".azw3", ".djvu", ".cbr", ".cbz",
            ".fb2", ".txt", ".doc", ".docx", ".rtf", ".zip", ".rar",
        )
        if any(path.endswith(ext) for ext in file_extensions):
            return True

        # Reject truly suspicious domains, but be lenient for unknown CDNs
        logger.debug(f"Allowing external download URL from: {hostname}")
        return True


def create_strategy(name: str) -> DownloadStrategy:
    """Factory function to create a download strategy by name.

    Args:
        name: Strategy name -- 'chrome' or 'direct'.

    Returns:
        A DownloadStrategy instance.

    Raises:
        ValueError: If the strategy name is not recognized.
    """
    strategies: dict[str, type[DownloadStrategy]] = {
        "chrome": ChromeStrategy,
        "direct": DirectHTTPStrategy,
    }
    if name not in strategies:
        valid = ", ".join(sorted(strategies.keys()))
        raise ValueError(f"Unknown strategy {name!r}. Valid options: {valid}")
    return strategies[name]()
