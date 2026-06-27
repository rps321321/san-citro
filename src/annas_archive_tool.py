import random
import json
import os
import re
import threading
import time
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse, unquote

from bs4 import BeautifulSoup
from tqdm import tqdm

from .logger import get_logger
from .shutdown import is_cancelled, register_driver, unregister_driver
from .utils import TRUSTED_DOMAINS, RateLimiter, get_browser_headers, get_working_domain

from .download_strategy import (
    DownloadStrategy,
    ChromeStrategy,
    DirectHTTPStrategy,
    create_strategy,
)

# TLS fingerprint impersonation: prefer curl_cffi when available
try:
    from curl_cffi import requests as stealth_requests
    import requests as std_requests  # keep standard requests for retry adapter
    HAS_CURL_CFFI = True
except ImportError:
    import requests as std_requests
    stealth_requests = None  # type: ignore[assignment]
    HAS_CURL_CFFI = False

from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = get_logger()

MD5_PATTERN = re.compile(r'^[a-f0-9]{32}$', re.IGNORECASE)


def _is_cancelled(cancel: Optional[threading.Event]) -> bool:
    """True if either the process-global shutdown or the per-job cancel is set."""
    return is_cancelled() or (cancel is not None and cancel.is_set())

# File magic bytes -> extension mapping
MAGIC_BYTES = {
    b"PK\x03\x04": ".epub",  # ZIP-based (EPUB, DOCX, ODT) -- default to epub
    b"%PDF": ".pdf",
    b"\x1f\x8b": ".gz",
    b"Rar!": ".rar",
    b"\xd0\xcf\x11\xe0": ".doc",
}


def _detect_filename(md5: str, file_path: str, content_disposition: str = "", download_url: str = "") -> str:
    """Detect the real filename from Content-Disposition header, download URL, or file magic bytes.

    Returns a human-readable filename like 'The Art of War - Sun Tzu.epub'
    or falls back to 'md5.ext' if no name can be determined.
    """
    # 1. Try Content-Disposition header: filename="The Art of War.epub"
    if content_disposition:
        match = re.search(r'filename[*]?=["\']?([^"\';\r\n]+)', content_disposition)
        if match:
            name = unquote(match.group(1).strip().strip('"').strip("'"))
            # Clean up URL-encoded names
            name = name.replace("+", " ").replace("%20", " ")
            if name and os.path.splitext(name)[1]:
                return _sanitize_filename(os.path.basename(name))

    # 2. Try download URL path — CDN URLs often contain the real filename
    #    e.g. .../Chapman%E2%80%99s+Homer%3A+The+Iliad+...+Anna%E2%80%99s+Archive.epub
    if download_url:
        parsed_path = unquote(urlparse(download_url).path)
        url_basename = os.path.basename(parsed_path)
        if url_basename:
            url_basename = url_basename.replace("+", " ").replace("%20", " ")
            name, ext = os.path.splitext(url_basename)
            if ext and len(ext) <= 6:
                # Strip "Anna's Archive" suffix (various separator styles)
                name = re.sub(r'\s*[-–—]+\s*Anna.s?\s*Archive\s*$', '', name, flags=re.IGNORECASE)
                # Strip MD5 hash (with various separators: --, —, spaces)
                name = re.sub(r'\s*[-–—]+\s*[a-f0-9]{32}\s*[-–—]*\s*$', '', name, flags=re.IGNORECASE)
                # Strip trailing dashes/spaces
                name = name.rstrip(' -–—')
                # Clean up double-dash separators: "Title -- Author -- Year" -> "Title - Author - Year"
                name = re.sub(r'\s*--\s*', ' - ', name)
                # Strip publisher/source suffixes like "Feedbooks", "Project Gutenberg"
                name = re.sub(r'\s*-\s*(?:Feedbooks|Project Gutenberg|Gutenberg|Internet Archive)\s*$',
                               '', name, flags=re.IGNORECASE)
                if name.strip():
                    return _sanitize_filename(name.strip() + ext)

    # 3. Try file magic bytes for extension only
    ext = ".file"
    try:
        with open(file_path, "rb") as f:
            header = f.read(8)
        for magic, magic_ext in MAGIC_BYTES.items():
            if header[:len(magic)] == magic:
                ext = magic_ext
                break
    except (OSError, IOError) as e:
        logger.debug("Failed to read magic bytes for %s: %s", file_path, e)

    return f"{md5}{ext}"


def _sanitize_filename(name: str) -> str:
    """Remove or replace characters that are invalid in filenames."""
    # Strip any path components — only keep the basename
    name = os.path.basename(name)
    # Remove path traversal sequences explicitly
    name = name.replace("..", "")
    name = name.replace("/", "_")
    name = name.replace("\\", "_")
    # Replace invalid filename characters
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    # Collapse multiple spaces/underscores
    name = re.sub(r'[_ ]{2,}', ' ', name)
    # Reject Windows reserved device names (CON, PRN, NUL, COM1-9, LPT1-9)
    _RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
    stem = os.path.splitext(name)[0].upper().strip()
    if stem in _RESERVED:
        name = f"_{name}"
    # Trim to reasonable length
    if len(name) > 200:
        base, ext = os.path.splitext(name)
        name = base[:200 - len(ext)] + ext
    return name.strip()

# Retry / polling constants
DOWNLOAD_MAX_RETRIES = 3
DOWNLOAD_BACKOFF_BASE = 4  # seconds: 4, 8, 16
META_MAX_AGE = 3600  # seconds before cached URL is considered stale (1 hour)


@dataclass
class DownloadMeta:
    """Cached download metadata stored as a .part.meta JSON sidecar."""

    download_url: str
    cookies: Dict[str, str]
    user_agent: str
    slow_link: str
    timestamp: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "download_url": self.download_url,
            "cookies": self.cookies,
            "user_agent": self.user_agent,
            "slow_link": self.slow_link,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DownloadMeta":
        return cls(
            download_url=data["download_url"],
            cookies=data.get("cookies", {}),
            user_agent=data.get("user_agent", ""),
            slow_link=data.get("slow_link", ""),
            timestamp=data.get("timestamp", 0.0),
        )

    def is_expired(self) -> bool:
        return (time.time() - self.timestamp) > META_MAX_AGE


def _load_meta(meta_path: str) -> Optional[DownloadMeta]:
    """Load a .part.meta sidecar file, returning None if missing or corrupt."""
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return DownloadMeta.from_dict(json.load(f))
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as e:
        logger.debug("Failed to load meta cache %s: %s", meta_path, e)
        return None


def _save_meta(meta_path: str, meta: DownloadMeta) -> None:
    """Persist download metadata to a .part.meta sidecar file."""
    try:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta.to_dict(), f, indent=2)
    except OSError as e:
        logger.warning(f"Could not write meta cache {meta_path}: {e}")


def _remove_meta(meta_path: str) -> None:
    """Delete the sidecar file if it exists."""
    try:
        os.remove(meta_path)
    except OSError:
        pass


class AnnasArchiveTool:
    """
    Anna's Archive Toolkit - VPN-Only Edition.
    A streamlined, high-stability tool designed for use with a system-wide VPN.

    Supports pluggable download strategies (Chrome or DirectHTTP),
    retry with exponential backoff, .part.meta caching to skip Chrome
    on re-runs, and graceful SIGINT shutdown.
    """

    def __init__(
        self,
        proxies: Optional[List[str]] = None,
        direct_mode: bool = False,
        strategy: Optional[DownloadStrategy] = None,
        base_url: Optional[str] = None,
    ) -> None:
        self.proxies = proxies or []
        self.direct_mode = direct_mode
        self.session = self._setup_resilient_session()
        self._search_session = self._setup_resilient_session()

        # Resolve base_url: explicit arg > config file > auto-detect
        if base_url:
            self.base_url = base_url.rstrip("/")
        else:
            from .config_manager import get_config
            configured_url = get_config().get("base_url")
            if configured_url:
                self.base_url = configured_url.rstrip("/")
            else:
                logger.info("Auto-detecting working Anna's Archive domain...")
                self.base_url = get_working_domain(session=self.session)
                logger.info(f"Using domain: {self.base_url}")

        self.strategy: DownloadStrategy = strategy or ChromeStrategy(proxies=self.proxies)
        self._rate_limiter = RateLimiter(min_delay=1.0, max_delay=5.0)

    # ------------------------------------------------------------------
    # Resource management
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the underlying requests sessions to release connections."""
        self.session.close()
        self._search_session.close()

    def __enter__(self) -> "AnnasArchiveTool":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    def get_random_proxy(self) -> Dict[str, str]:
        """Return a random proxy dict for requests, or empty dict if no proxies configured."""
        if self.proxies:
            proxy_url = random.choice(self.proxies)
            return {"http": proxy_url, "https": proxy_url}
        return {}

    def _setup_resilient_session(self) -> std_requests.Session:
        """Create a session with automatic retries for metadata/search requests.

        When ``curl_cffi`` is installed, the session impersonates a real Chrome
        browser TLS fingerprint (JA3/JA4), making requests indistinguishable
        from genuine browser traffic.  Falls back to standard ``requests``
        otherwise (which has a recognisable Python TLS fingerprint).
        """
        if HAS_CURL_CFFI:
            session = stealth_requests.Session(impersonate="chrome131")
            logger.debug("Using curl_cffi session (TLS fingerprint: chrome131)")
        else:
            session = std_requests.Session()
            retry = Retry(total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
            adapter = HTTPAdapter(max_retries=retry)
            session.mount("https://", adapter)
            session.mount("http://", adapter)

        session.headers.update(get_browser_headers())
        if self.proxies:
            proxy_url = random.choice(self.proxies)
            session.proxies = {"http": proxy_url, "https": proxy_url}
        return session

    def _setup_download_session(self) -> std_requests.Session:
        """Create a session with NO automatic retries for file downloads.

        The outer retry loop in _download_file_with_retry handles retries,
        so the adapter must not retry on its own to avoid multiplicative attempts.

        Uses ``curl_cffi`` when available for TLS fingerprint impersonation.
        """
        if HAS_CURL_CFFI:
            session = stealth_requests.Session(impersonate="chrome131")
        else:
            session = std_requests.Session()
            adapter = HTTPAdapter(max_retries=Retry(total=0))
            session.mount("https://", adapter)
            session.mount("http://", adapter)

        session.headers.update(get_browser_headers())
        if self.proxies:
            proxy_url = random.choice(self.proxies)
            session.proxies = {"http": proxy_url, "https": proxy_url}
        return session

    def get_slow_download_link(self, md5: str) -> Optional[str]:
        if not MD5_PATTERN.match(md5):
            logger.error(f"Invalid MD5 hash: {md5!r}")
            return None

        url = f"{self.base_url}/md5/{md5}"
        try:
            res = self._search_session.get(
                url,
                headers=get_browser_headers(referer=self.base_url),
                timeout=15,
                verify=True,
            )
            res.raise_for_status()
            soup = BeautifulSoup(res.text, "html.parser")
            for a in soup.find_all("a"):
                href = a.get("href", "")
                if "/slow_download/" in href:
                    if href.startswith("/"):
                        return self.base_url + href
                    # Validate absolute URLs against trusted domains
                    parsed = urlparse(href)
                    if parsed.hostname and parsed.hostname in TRUSTED_DOMAINS:
                        return href
                    logger.warning(f"Untrusted download domain: {parsed.hostname}")
                    return None
        except std_requests.RequestException as e:
            logger.error(f"Failed to get download link: {e}")
        return None

    # ------------------------------------------------------------------
    # Strategy-based download orchestration
    # ------------------------------------------------------------------

    def automated_slow_download(
        self,
        md5: str,
        output_dir: str = "downloads",
        custom_filename: Optional[str] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Optional[str]:
        if not MD5_PATTERN.match(md5):
            logger.error(f"Invalid MD5 hash: {md5!r}")
            return None

        if _is_cancelled(cancel):
            logger.info(f"[{md5[:6]}] Download skipped — shutdown in progress")
            return None

        slow_link = self.get_slow_download_link(md5)
        if not slow_link:
            return None

        logger.info(f"[{md5[:6]}] Attempting download via {type(self.strategy).__name__}")

        # Derive the meta-cache path from the .part file path
        filename = custom_filename or f"{md5}.file"
        os.makedirs(output_dir, exist_ok=True)
        meta_path = os.path.join(output_dir, filename + ".part.meta")

        # --- Try cached URL first ---
        cached_meta = _load_meta(meta_path)
        if cached_meta is not None and not cached_meta.is_expired():
            logger.info(f"[{md5[:6]}] Found cached download URL, validating...")
            if self._is_cached_url_valid(cached_meta):
                logger.info(f"[{md5[:6]}] Cached URL is still valid, skipping strategy phase")
                result = self._download_file_with_retry(
                    cached_meta, md5, output_dir, custom_filename, cancel=cancel
                )
                if result:
                    _remove_meta(meta_path)
                return result
            else:
                logger.info(f"[{md5[:6]}] Cached URL expired or invalid, re-running strategy")
                _remove_meta(meta_path)

        if _is_cancelled(cancel):
            logger.info(f"[{md5[:6]}] Download skipped — shutdown in progress")
            return None

        # --- Strategy phase: try primary then fallback ---
        strategy_result = self.strategy.get_download_url(
            slow_link, md5, self.session, self.base_url
        )

        if strategy_result is None:
            fallback = self._get_fallback_strategy()
            if fallback is not None:
                logger.info(
                    f"[{md5[:6]}] Primary strategy failed, "
                    f"falling back to {type(fallback).__name__}"
                )
                strategy_result = fallback.get_download_url(
                    slow_link, md5, self.session, self.base_url
                )

        if strategy_result is None:
            logger.error(f"[{md5[:6]}] All download strategies failed")
            return None

        download_url, cookies, headers = strategy_result

        # Build a DownloadMeta for caching and retry
        meta = DownloadMeta(
            download_url=download_url,
            cookies=cookies,
            user_agent=headers.get("User-Agent", ""),
            slow_link=slow_link,
            timestamp=time.time(),
        )

        # Persist the URL + cookies so a re-run can skip strategy phase
        _save_meta(meta_path, meta)

        # --- Download phase with retry ---
        result = self._download_file_with_retry(
            meta, md5, output_dir, custom_filename, cancel=cancel
        )
        if result:
            _remove_meta(meta_path)
        return result

    def _get_fallback_strategy(self) -> Optional[DownloadStrategy]:
        """Return the opposite strategy for fallback, or None if no fallback is available."""
        if isinstance(self.strategy, DirectHTTPStrategy):
            return ChromeStrategy(proxies=self.proxies)
        if isinstance(self.strategy, ChromeStrategy):
            return DirectHTTPStrategy(proxies=self.proxies)
        return None

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def _is_cached_url_valid(self, meta: DownloadMeta) -> bool:
        """Verify a cached download URL is still reachable via HEAD request."""
        session = self._setup_resilient_session()
        try:
            session.cookies.update(meta.cookies)
            head_resp = session.head(
                meta.download_url,
                headers={
                    "User-Agent": meta.user_agent,
                    "Referer": meta.slow_link,
                },
                timeout=15,
                allow_redirects=True,
                verify=True,
            )
            # Accept 200-399 as "still valid"
            return head_resp.status_code < 400
        except std_requests.RequestException:
            return False
        finally:
            session.close()

    # ------------------------------------------------------------------
    # Download with retry + exponential backoff
    # ------------------------------------------------------------------

    def _download_file_with_retry(
        self,
        meta: DownloadMeta,
        md5: str,
        output_dir: str,
        custom_filename: Optional[str] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Optional[str]:
        """
        Download the file from *meta.download_url* into *output_dir*.

        Retries up to DOWNLOAD_MAX_RETRIES times with exponential backoff
        on transient HTTP / network errors.  Supports resume via Range
        header when a .part file already exists.

        Checks cancellation between retry attempts.

        Returns the final file path on success, or None on failure.
        """
        filename = custom_filename or f"{md5}.file"
        os.makedirs(output_dir, exist_ok=True)
        final_path = os.path.join(output_dir, filename)

        # Path traversal guard
        real_final = os.path.realpath(final_path)
        real_out = os.path.realpath(output_dir)
        if not real_final.startswith(real_out + os.sep) and real_final != real_out:
            logger.error(f"Path traversal blocked: {filename!r}")
            return None

        part_path = final_path + ".part"

        last_error: Optional[Exception] = None
        for attempt in range(1, DOWNLOAD_MAX_RETRIES + 1):
            if _is_cancelled(cancel):
                logger.info(f"[{md5[:6]}] Download skipped — shutdown in progress")
                return None

            try:
                result = self._attempt_download(
                    meta=meta,
                    md5=md5,
                    part_path=part_path,
                    final_path=final_path,
                    filename=filename,
                    output_dir=output_dir,
                    cancel=cancel,
                )
                if result is not None:
                    return result
                # result is None but no exception -- MD5 mismatch, don't retry
                return None
            except std_requests.exceptions.SSLError as e:
                # SSL errors (expired cert, MITM) never fix themselves on retry
                logger.error(f"[{md5[:6]}] SSL certificate error — not retrying: {e}")
                return None
            except std_requests.HTTPError as e:
                # Don't retry on permanent HTTP errors
                if e.response is not None and e.response.status_code in (401, 403, 404, 410):
                    logger.error(f"[{md5[:6]}] HTTP {e.response.status_code} — not retrying: {e}")
                    return None
                last_error = e
            except std_requests.RequestException as e:
                last_error = e

            # Retry logic for transient errors (shared by HTTPError and RequestException)
            if last_error is not None and attempt < DOWNLOAD_MAX_RETRIES:
                wait = DOWNLOAD_BACKOFF_BASE * (2 ** (attempt - 1))
                logger.warning(
                    f"[{md5[:6]}] Download attempt {attempt}/{DOWNLOAD_MAX_RETRIES} "
                    f"failed: {last_error} -- retrying in {wait}s"
                )
                for _ in range(wait):
                    if _is_cancelled(cancel):
                        return None
                    time.sleep(1)
            elif last_error is not None:
                logger.error(
                    f"[{md5[:6]}] Download failed after {DOWNLOAD_MAX_RETRIES} "
                    f"attempts: {last_error}"
                )
        return None

    def _attempt_download(
        self,
        meta: DownloadMeta,
        md5: str,
        part_path: str,
        final_path: str,
        filename: str,
        output_dir: str = "downloads",
        cancel: Optional[threading.Event] = None,
    ) -> Optional[str]:
        """
        Single download attempt.  Raises requests.RequestException on
        transient failures so the caller can retry.

        Returns final_path on success, None on MD5 mismatch (non-retryable).
        """
        session = self._setup_download_session()
        try:
            session.cookies.update(meta.cookies)
            headers: Dict[str, str] = {
                "User-Agent": meta.user_agent,
                "Referer": meta.slow_link,
            }
            existing_size = os.path.getsize(part_path) if os.path.exists(part_path) else 0
            if existing_size:
                headers["Range"] = f"bytes={existing_size}-"

            res = session.get(
                meta.download_url, headers=headers, stream=True,
                timeout=(15, 120),  # (connect_timeout, read_timeout)
                verify=True
            )

            if res.status_code != 416:
                res.raise_for_status()
                total = int(res.headers.get("content-length", 0)) + existing_size

                # Write total size to a sidecar so the progress poller can
                # compute a meaningful percentage without polling the tool internals.
                if total > 0:
                    size_path = part_path + ".size"
                    try:
                        with open(size_path, "w") as _sf:
                            _sf.write(str(total))
                    except OSError:
                        pass

                cancelled = False
                with open(part_path, "ab" if existing_size else "wb") as f, tqdm(
                    desc=f"Downloading {filename[:25]}",
                    total=total,
                    initial=existing_size,
                    unit="iB",
                    unit_scale=True,
                ) as bar:
                    for chunk in res.iter_content(chunk_size=16384):
                        if _is_cancelled(cancel):
                            cancelled = True
                            logger.info(
                                f"[{md5[:6]}] Download interrupted — "
                                f".part file kept for resume ({part_path})"
                            )
                            break
                        if chunk:
                            bar.update(f.write(chunk))

                if cancelled:
                    return None

            h = hashlib.md5()
            with open(part_path, "rb") as f:
                for chunk in iter(lambda: f.read(4096), b""):
                    h.update(chunk)
            if h.hexdigest().lower() == md5.lower():
                # Detect real filename if we're using the generic md5.file name
                if filename.endswith(".file") or filename == f"{md5}.file":
                    content_disp = res.headers.get("Content-Disposition", "")
                    real_name = _detect_filename(md5, part_path, content_disp, meta.download_url)
                    if real_name != filename:
                        final_path = os.path.join(os.path.dirname(final_path), real_name)
                        filename = real_name
                        # Re-validate path traversal after filename detection
                        real_final = os.path.realpath(final_path)
                        real_out = os.path.realpath(output_dir)
                        if not real_final.startswith(real_out + os.sep) and real_final != real_out:
                            logger.error(f"Path traversal blocked after filename detection: {filename!r}")
                            os.remove(part_path)
                            return None
                # Handle existing file — add (1), (2) suffix if duplicate
                if os.path.exists(final_path):
                    base, ext = os.path.splitext(final_path)
                    counter = 1
                    while os.path.exists(final_path):
                        final_path = f"{base} ({counter}){ext}"
                        counter += 1
                    filename = os.path.basename(final_path)
                os.rename(part_path, final_path)
                logger.info(f"[{md5[:6]}] Completed: {filename}")
                return final_path
            else:
                logger.warning(f"[{md5[:6]}] MD5 mismatch -- downloaded file is corrupt")
                os.remove(part_path)
                return None
        finally:
            session.close()

    # ------------------------------------------------------------------
    # Metadata / torrents
    # ------------------------------------------------------------------

    def get_torrents_json(self) -> Any:
        res = self.session.get(f"{self.base_url}/dyn/torrents.json", verify=True)
        res.raise_for_status()
        return res.json()

    def get_metadata_dumps(self) -> List[Dict[str, Any]]:
        try:
            data = self.get_torrents_json()
            return sorted(
                [i for i in data if i.get("group_name") == "aa_derived_mirror_metadata"],
                key=lambda x: x.get("added_to_torrents_list_at", ""),
            )
        except std_requests.RequestException as e:
            logger.error(f"Failed to fetch metadata dumps: {e}")
            return []
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
            logger.error(f"Malformed response from torrents API: {e}")
            return []
