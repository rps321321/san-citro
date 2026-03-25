import requests
from bs4 import BeautifulSoup
import json
import os
import re
import time
import hashlib
from typing import Optional, List, Dict, Any
from logger import get_logger
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = get_logger()

MD5_PATTERN = re.compile(r'^[a-f0-9]{32}$', re.IGNORECASE)
TRUSTED_DOMAINS = {"annas-archive.gl", "annas-archive.org", "annas-archive.se"}


class AnnasArchiveTool:
    """
    Anna's Archive Toolkit - VPN-Only Edition.
    A streamlined, high-stability tool designed for use with a system-wide VPN.
    """

    def __init__(
        self,
        proxies: Optional[List[str]] = None,
        direct_mode: bool = False,
    ) -> None:
        self.base_url = "https://annas-archive.gl"
        self.proxies = proxies or []
        self.direct_mode = direct_mode
        self.session = self._setup_resilient_session()

    def _setup_resilient_session(self) -> requests.Session:
        session = requests.Session()
        retry = Retry(total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    def get_slow_download_link(self, md5: str) -> Optional[str]:
        if not MD5_PATTERN.match(md5):
            logger.error(f"Invalid MD5 hash: {md5!r}")
            return None

        url = f"{self.base_url}/md5/{md5}"
        try:
            res = self.session.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
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
                    from urllib.parse import urlparse
                    parsed = urlparse(href)
                    if parsed.hostname and parsed.hostname in TRUSTED_DOMAINS:
                        return href
                    logger.warning(f"Untrusted download domain: {parsed.hostname}")
                    return None
        except requests.RequestException as e:
            logger.error(f"Failed to get download link: {e}")
        return None

    def automated_slow_download(
        self,
        md5: str,
        output_dir: str = "downloads",
        custom_filename: Optional[str] = None,
    ) -> Optional[str]:
        import undetected_chromedriver as uc

        if not MD5_PATTERN.match(md5):
            logger.error(f"Invalid MD5 hash: {md5!r}")
            return None

        slow_link = self.get_slow_download_link(md5)
        if not slow_link:
            return None

        logger.info(f"[{md5[:6]}] Attempting download via VPN (Direct Connection)")
        driver = None
        try:
            options = uc.ChromeOptions()
            options.add_argument("--disable-blink-features=AutomationControlled")
            driver = uc.Chrome(options=options)
            driver.get(slow_link)

            download_url = None
            download_keywords = ["download now", "download", "save"]
            max_polls = 30  # 30 × 5s = 150s max (covers variable countdowns up to ~120s)
            poll_interval = 5
            for attempt in range(max_polls):
                time.sleep(poll_interval)
                if attempt > 0 and attempt % 6 == 0:
                    logger.info(f"[{md5[:6]}] Waiting for countdown... ({attempt * poll_interval}s elapsed)")
                try:
                    for a in driver.find_elements("tag name", "a"):
                        text = (a.text or "").lower().strip()
                        href = a.get_attribute("href") or ""
                        # Match: text contains a download keyword AND href is a real
                        # external URL (not a page anchor like #)
                        has_keyword = any(kw in text for kw in download_keywords)
                        is_real_url = href.startswith("http") and not href.endswith("#")
                        is_not_self = self.base_url not in href
                        if has_keyword and is_real_url and is_not_self:
                            download_url = href
                            logger.info(
                                f"[{md5[:6]}] Found download link after {attempt * poll_interval}s"
                            )
                            break
                except Exception as e:
                    logger.debug(f"Selenium poll error (retrying): {e}")
                if download_url:
                    break

            if not download_url:
                logger.warning(
                    f"[{md5[:6]}] No download link found after {max_polls * poll_interval}s"
                )
                return None

            cookies = {c["name"]: c["value"] for c in driver.get_cookies()}
            user_agent = driver.execute_script("return navigator.userAgent;")

        except Exception as e:
            logger.error(f"[{md5[:6]}] Browser automation failed: {e}")
            return None
        finally:
            if driver:
                try:
                    driver.quit()
                except Exception:
                    pass

        # --- Download phase (driver already closed) ---
        try:
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

            session = self.session
            session.cookies.update(cookies)
            headers = {"User-Agent": user_agent, "Referer": slow_link}
            existing_size = os.path.getsize(part_path) if os.path.exists(part_path) else 0
            if existing_size:
                headers["Range"] = f"bytes={existing_size}-"

            res = session.get(download_url, headers=headers, stream=True, timeout=120, verify=True)

            if res.status_code != 416:
                res.raise_for_status()
                total = int(res.headers.get("content-length", 0)) + existing_size
                from tqdm import tqdm

                with open(part_path, "ab" if existing_size else "wb") as f, tqdm(
                    desc=f"Downloading {filename[:25]}",
                    total=total,
                    initial=existing_size,
                    unit="iB",
                    unit_scale=True,
                ) as bar:
                    for chunk in res.iter_content(chunk_size=16384):
                        if chunk:
                            bar.update(f.write(chunk))

            h = hashlib.md5()
            with open(part_path, "rb") as f:
                for chunk in iter(lambda: f.read(4096), b""):
                    h.update(chunk)
            if h.hexdigest().lower() == md5.lower():
                os.rename(part_path, final_path)
                return final_path
            else:
                logger.warning(f"[{md5[:6]}] MD5 mismatch — downloaded file is corrupt")
                os.remove(part_path)
        except Exception as e:
            logger.error(f"[{md5[:6]}] Download failed: {e}")
        return None

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
        except requests.RequestException as e:
            logger.error(f"Failed to fetch metadata dumps: {e}")
            return []
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
            logger.error(f"Malformed response from torrents API: {e}")
            return []
