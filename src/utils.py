"""Shared utility functions and constants for the Anna's Archive toolkit."""

import logging
import random
import threading
import time
from typing import TYPE_CHECKING, Optional
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

if TYPE_CHECKING:
    import requests

_utils_logger = logging.getLogger(__name__)


# Ordered list of known Anna's Archive domains (preferred first).
# Anna's Archive has changed domains multiple times (.org -> .gs -> .se -> .gl).
# get_working_domain() tests them in order and returns the first that responds.
ANNAS_ARCHIVE_DOMAINS = [
    "https://annas-archive.gl",
    "https://annas-archive.se",
    "https://annas-archive.org",
    "https://annas-archive.li",
]

# Domains trusted for Anna's Archive downloads (hostnames only, no scheme)
TRUSTED_DOMAINS = {
    "annas-archive.gl",
    "annas-archive.se",
    "annas-archive.org",
    "annas-archive.li",
}


def attr_str(value: object) -> str | None:
    """Return a single-valued BeautifulSoup tag attribute as ``str`` or ``None``.

    ``Tag.get()`` may return a ``str``, a list (for multi-valued attributes such
    as ``class``), or ``None``. Callers that want one string (``href``, ``src``,
    ``content``) treat anything that is not a ``str`` as missing.
    """
    return value if isinstance(value, str) else None


def get_working_domain(session: Optional["requests.Session"] = None, timeout: int = 10) -> str:
    """Test domains in order, return the first one that responds with HTTP < 400.

    Args:
        session: An optional requests.Session to reuse. A temporary one is
                 created if not provided.
        timeout: Per-domain connection timeout in seconds.

    Returns:
        The first reachable domain URL, or the first entry in
        ANNAS_ARCHIVE_DOMAINS as a last-resort fallback.
    """
    import requests as _requests

    s = session or _requests.Session()
    close_session = session is None

    try:
        for domain in ANNAS_ARCHIVE_DOMAINS:
            try:
                resp = s.get(domain, timeout=timeout, allow_redirects=True)
                if resp.status_code < 400:
                    return domain
            except _requests.RequestException:
                continue
    finally:
        if close_session:
            s.close()

    return ANNAS_ARCHIVE_DOMAINS[0]  # fallback to first


# Realistic User-Agent rotation pool (updated late-2024 / early-2025 strings)
REALISTIC_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


def get_random_user_agent() -> str:
    """Return a random realistic browser User-Agent string."""
    return random.choice(REALISTIC_USER_AGENTS)


def get_browser_headers(referer: str = "") -> dict[str, str]:
    """Return a full set of realistic browser headers.

    Includes Sec-CH-UA client hints for Chrome UAs and adjusts
    Sec-Fetch-Site when a referer is provided.
    """
    ua = get_random_user_agent()
    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    }
    if "Chrome" in ua:
        headers["sec-ch-ua"] = '"Chromium";v="131", "Not_A Brand";v="24"'
        headers["sec-ch-ua-mobile"] = "?0"
        headers["sec-ch-ua-platform"] = '"Windows"'
    if referer:
        headers["Referer"] = referer
        headers["Sec-Fetch-Site"] = "same-origin"
    return headers


class RateLimiter:
    """Token bucket rate limiter with random jitter to emulate human behavior.

    Ensures a random delay between ``min_delay`` and ``max_delay`` seconds
    elapses between consecutive outbound requests.  Thread-safe.
    """

    def __init__(self, min_delay: float = 1.0, max_delay: float = 5.0) -> None:
        self.min_delay = min_delay
        self.max_delay = max_delay
        self._lock = threading.Lock()
        self._last_request: float = 0.0

    def wait(self) -> None:
        """Block until it is safe to make the next request."""
        with self._lock:
            now = time.monotonic()
            delay = random.uniform(self.min_delay, self.max_delay)
            elapsed = now - self._last_request
            if elapsed < delay:
                time.sleep(delay - elapsed)
            self._last_request = time.monotonic()


# ---------------------------------------------------------------------------
# Anti-bot / CAPTCHA response detection
# ---------------------------------------------------------------------------


class BlockType:
    """Categories of anti-bot responses a site may return."""

    NONE = "none"
    CAPTCHA = "captcha"
    CLOUDFLARE = "cloudflare"
    ACCESS_DENIED = "access_denied"
    RATE_LIMITED = "rate_limited"
    EMPTY_RESPONSE = "empty_response"


class ResponseCheck:
    """Result of inspecting an HTTP response for bot-detection signals."""

    __slots__ = ("block_type", "is_blocked", "message")

    def __init__(self, is_blocked: bool, block_type: str, message: str) -> None:
        self.is_blocked = is_blocked
        self.block_type = block_type
        self.message = message

    def __repr__(self) -> str:
        return (
            f"ResponseCheck(is_blocked={self.is_blocked}, " f"block_type={self.block_type!r}, message={self.message!r})"
        )


def check_response_for_blocks(response: "requests.Response") -> ResponseCheck:
    """Check if a response indicates we have been blocked or challenged.

    Inspects the HTTP status code first, then scans the response body for
    well-known CAPTCHA and Cloudflare challenge markers.  All detections are
    logged at WARNING level with the block type and URL.

    Args:
        response: A ``requests.Response`` object to inspect.

    Returns:
        A ``ResponseCheck`` describing the block state.
    """
    url = response.url

    # -- HTTP status checks --------------------------------------------------
    if response.status_code == 429:
        _utils_logger.warning("[anti-bot] RATE_LIMITED at %s", url)
        return ResponseCheck(True, BlockType.RATE_LIMITED, "Rate limited (429)")

    if response.status_code == 403:
        _utils_logger.warning("[anti-bot] ACCESS_DENIED at %s", url)
        return ResponseCheck(True, BlockType.ACCESS_DENIED, "Access denied (403)")

    if response.status_code == 503:
        body_lower = response.text[:2000].lower()
        if "cloudflare" in body_lower or "cf-browser-verification" in body_lower:
            _utils_logger.warning("[anti-bot] CLOUDFLARE challenge at %s", url)
            return ResponseCheck(True, BlockType.CLOUDFLARE, "Cloudflare challenge detected (503)")
        _utils_logger.warning("[anti-bot] RATE_LIMITED (503) at %s", url)
        return ResponseCheck(True, BlockType.RATE_LIMITED, "Service unavailable (503)")

    # -- Body inspection (status 200 can still be a block page) ---------------
    if response.status_code == 200:
        body_lower = response.text[:5000].lower()

        captcha_markers = [
            "captcha",
            "recaptcha",
            "hcaptcha",
            "cf-turnstile",
            "challenge-form",
            "verify you are human",
            "bot detection",
        ]
        for marker in captcha_markers:
            if marker in body_lower:
                _utils_logger.warning("[anti-bot] CAPTCHA (%s) at %s", marker, url)
                return ResponseCheck(
                    True,
                    BlockType.CAPTCHA,
                    f"CAPTCHA detected: '{marker}' found in response",
                )

        # Suspiciously small response masquerading as a real page
        if len(response.text) < 500 and "<!doctype" not in body_lower:
            _utils_logger.warning(
                "[anti-bot] EMPTY_RESPONSE (%d bytes) at %s",
                len(response.text),
                url,
            )
            return ResponseCheck(
                True,
                BlockType.EMPTY_RESPONSE,
                f"Suspiciously small response ({len(response.text)} bytes)",
            )

        # Cloudflare JS challenge delivered with a 200 status
        if "cf-browser-verification" in body_lower or "jschl-answer" in body_lower:
            _utils_logger.warning("[anti-bot] CLOUDFLARE JS challenge (200) at %s", url)
            return ResponseCheck(
                True,
                BlockType.CLOUDFLARE,
                "Cloudflare JS challenge in 200 response",
            )

    return ResponseCheck(False, BlockType.NONE, "OK")


def format_filesize(size_bytes: int | None) -> str:
    """Convert a byte count to a human-readable string.

    Returns ``"N/A"`` when *size_bytes* is ``None`` or zero.

    Examples:
        >>> format_filesize(None)
        'N/A'
        >>> format_filesize(0)
        'N/A'
        >>> format_filesize(512)
        '512 B'
        >>> format_filesize(1536)
        '1.5 KB'
        >>> format_filesize(2_621_440)
        '2.5 MB'
        >>> format_filesize(1_610_612_736)
        '1.50 GB'
    """
    if not size_bytes:
        return "N/A"
    if size_bytes >= 1024**3:
        return f"{size_bytes / (1024 ** 3):.2f} GB"
    if size_bytes >= 1024**2:
        return f"{size_bytes / (1024 ** 2):.1f} MB"
    if size_bytes >= 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes} B"


# ---------------------------------------------------------------------------
# robots.txt awareness
# ---------------------------------------------------------------------------

_robot_parsers: dict[str, RobotFileParser] = {}


def is_allowed_by_robots(url: str, user_agent: str = "*") -> bool:
    """Check if a URL is allowed by the site's robots.txt.

    Returns ``True`` (allow) when robots.txt is unreachable or unparseable.
    Logs a warning when the URL is disallowed but does **not** block the
    request -- callers decide how to proceed.
    """
    parsed = urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    if base not in _robot_parsers:
        rp = RobotFileParser()
        rp.set_url(f"{base}/robots.txt")
        try:
            rp.read()
        except Exception:
            return True  # If robots.txt is unreachable, allow
        _robot_parsers[base] = rp
    allowed = _robot_parsers[base].can_fetch(user_agent, url)
    if not allowed:
        _utils_logger.warning(
            "robots.txt disallows access to %s for user-agent %r",
            url,
            user_agent,
        )
    return allowed


# ---------------------------------------------------------------------------
# Proxy validation helpers
# ---------------------------------------------------------------------------

_SUPPORTED_PROXY_SCHEMES = {"http", "https", "socks4", "socks5"}


def validate_proxy_url(url: str) -> tuple[bool, str]:
    """Validate a proxy URL format.

    Returns a ``(is_valid, message)`` tuple.  Only checks syntax -- does **not**
    test connectivity.

    Examples:
        >>> validate_proxy_url("http://127.0.0.1:8080")
        (True, 'OK')
        >>> validate_proxy_url("ftp://badscheme:1234")
        (False, "Unsupported scheme 'ftp' ...")
    """
    if not url or not url.strip():
        return False, "Proxy URL is empty"
    try:
        parsed = urlparse(url)
    except Exception as exc:
        return False, f"Malformed URL: {exc}"

    if not parsed.scheme:
        return False, "Missing scheme (e.g. http://)"
    if parsed.scheme not in _SUPPORTED_PROXY_SCHEMES:
        return (
            False,
            f"Unsupported scheme '{parsed.scheme}' -- expected one of: "
            f"{', '.join(sorted(_SUPPORTED_PROXY_SCHEMES))}",
        )
    if not parsed.hostname:
        return False, "Missing hostname"
    if not parsed.port:
        return False, "Missing port"
    return True, "OK"


def test_proxy_connectivity(
    proxy_url: str,
    test_url: str = "https://httpbin.org/ip",
    timeout: int = 10,
) -> tuple[bool, str]:
    """Test whether a proxy is reachable and forwarding traffic.

    Returns ``(is_working, result_message)``.  Uses a lightweight IP-echo
    endpoint by default so the check is fast and side-effect-free.
    """
    import requests  # deferred -- not needed at module load time

    is_valid, err = validate_proxy_url(proxy_url)
    if not is_valid:
        return False, f"Invalid URL: {err}"

    proxies = {"http": proxy_url, "https": proxy_url}
    try:
        resp = requests.get(test_url, proxies=proxies, timeout=timeout)
        if resp.status_code == 200:
            try:
                origin = resp.json().get("origin", "unknown")
            except ValueError:
                origin = "unknown"
            return True, f"Working (IP: {origin})"
        return False, f"HTTP {resp.status_code}"
    except requests.exceptions.ProxyError as exc:
        return False, f"Proxy error: {exc}"
    except requests.exceptions.ConnectTimeout:
        return False, "Connection timed out"
    except requests.RequestException as exc:
        return False, f"Connection failed: {exc}"
