import json
import logging
import os
import platform
import shutil
from pathlib import Path
from typing import Optional, List, Any, Dict
from urllib.parse import urlsplit, urlunsplit

APP_NAME = "san-citro"

# Legacy config path (the old location inside src/)
_LEGACY_CONFIG_PATH = Path(__file__).parent / "annas_config.json"

# Module-level override: set by set_config_path() when --config is used
_config_path_override: Optional[Path] = None


def _get_platform_config_dir() -> Path:
    """Return the platform-appropriate config directory using only stdlib.

    If the APPDATA_OVERRIDE env var is set, use that path directly.

    - Linux:  $XDG_CONFIG_HOME/san-citro  (defaults to ~/.config/san-citro)
    - macOS:  ~/Library/Application Support/san-citro
    - Windows: %APPDATA%/san-citro
    """
    override = os.environ.get("APPDATA_OVERRIDE")
    if override:
        return Path(override)

    system = platform.system()

    if system == "Windows":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / APP_NAME
        # Fallback if APPDATA is somehow unset
        return Path.home() / "AppData" / "Roaming" / APP_NAME

    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME

    # Linux and other POSIX systems: respect XDG_CONFIG_HOME
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / APP_NAME
    return Path.home() / ".config" / APP_NAME


def get_config_path() -> Path:
    """Return the active config file path, respecting overrides."""
    if _config_path_override is not None:
        return _config_path_override
    return _get_platform_config_dir() / "config.json"


def get_default_history_db_path() -> str:
    """Return the platform data-dir path for the download history database.

    Uses the same XDG/AppData logic as the config file and ensures the parent
    directory exists. Resolved on use when ``history_db`` is unset in config.
    """
    db_path = _get_platform_config_dir() / "download_history.db"
    _ensure_config_dir(db_path)
    return str(db_path)


def set_config_path(path: str) -> None:
    """Override the config file path (used by --config CLI flag)."""
    global _config_path_override
    _config_path_override = Path(path)


def _ensure_config_dir(config_path: Path) -> None:
    """Create the config directory if it doesn't exist."""
    config_path.parent.mkdir(parents=True, exist_ok=True)


def _migrate_legacy_config() -> None:
    """Migrate config from old src/annas_config.json to the new platform location.

    Only runs when:
    - The legacy file exists
    - No override is set (user isn't using --config)
    - The new-location file does NOT already exist
    """
    if _config_path_override is not None:
        return

    new_path = get_config_path()
    if new_path.exists():
        return
    if not _LEGACY_CONFIG_PATH.exists():
        return

    logger = logging.getLogger("annas_archive")
    try:
        _ensure_config_dir(new_path)
        shutil.copy2(str(_LEGACY_CONFIG_PATH), str(new_path))
        logger.info(
            f"Migrated config from {_LEGACY_CONFIG_PATH} -> {new_path}"
        )
        # Remove legacy file after successful copy
        _LEGACY_CONFIG_PATH.unlink()
        logger.info(f"Removed legacy config file: {_LEGACY_CONFIG_PATH}")
    except OSError as e:
        logger.warning(
            f"Failed to migrate legacy config: {e} — continuing with defaults"
        )


# Keep backward-compatible module-level attribute for tests that patch it
CONFIG_PATH = get_config_path()


def get_config() -> Dict[str, Any]:
    """Load settings from the config file with default fallbacks.

    On first call, attempts migration from the legacy location.
    """
    defaults: Dict[str, Any] = {
        "out_dir": "downloads",
        "concurrency": 2,
        "proxies": [],
        "base_url": None,  # None = auto-detect via get_working_domain()
        "history_db": None,  # None -> resolved via get_default_history_db_path()
    }

    # Attempt migration from legacy location
    _migrate_legacy_config()

    config_path = get_config_path()
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            return {**defaults, **config}
        except (json.JSONDecodeError, OSError) as e:
            logging.getLogger("annas_archive").warning(
                f"Config file is corrupt or unreadable ({config_path}): {e} — using defaults"
            )
            return defaults
    return defaults


def save_config(
    out_dir: Optional[str] = None,
    concurrency: Optional[int] = None,
    proxies: Optional[List[str]] = None,
    base_url: Optional[str] = None,
    history_db: Optional[str] = None,
) -> Dict[str, Any]:
    """Save current settings to the config file.

    Args:
        base_url: Anna's Archive base URL override. Pass an empty string or
                  ``None`` to keep the current value. Set to a URL like
                  ``"https://annas-archive.gl"`` to pin a specific domain,
                  or leave as ``None`` in config to use auto-detection.
    """
    config = get_config()
    if out_dir is not None:
        config["out_dir"] = out_dir
    if concurrency is not None:
        config["concurrency"] = concurrency
    if proxies is not None:
        config["proxies"] = proxies
    if base_url is not None:
        config["base_url"] = base_url or None  # empty string -> None (auto-detect)
    if history_db is not None:
        config["history_db"] = history_db

    config_path = get_config_path()
    _ensure_config_dir(config_path)
    # Atomic write: write to temp file first, then replace to prevent corruption
    # if the process is killed mid-write.
    import tempfile
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=os.path.dirname(config_path), suffix=".tmp"
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(config, f, indent=4)
        os.replace(tmp_path, config_path)
    except BaseException:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return config


# ---------------------------------------------------------------------------
# Shared helpers (consolidated here; imported by the Electron bridge + CLI)
# ---------------------------------------------------------------------------

# Concurrency bounds — single source of truth.
CONCURRENCY_MIN: int = 1
CONCURRENCY_MAX: int = 32


def redact_proxy_url(url: str) -> str:
    """Strip username/password from a proxy URL's netloc.

    Returns the url unchanged if it has no credentials or cannot be parsed.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if "@" not in parts.netloc:
        return url
    host = parts.netloc.rsplit("@", 1)[1]
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def clamp_concurrency(value: int) -> int:
    """Clamp a concurrency value into [CONCURRENCY_MIN, CONCURRENCY_MAX]."""
    return max(CONCURRENCY_MIN, min(CONCURRENCY_MAX, int(value)))


def validate_concurrency(value: int) -> int:
    """Return ``int(value)`` if within bounds, else raise ValueError."""
    ivalue = int(value)
    if ivalue < CONCURRENCY_MIN or ivalue > CONCURRENCY_MAX:
        raise ValueError("concurrency must be between 1 and 32.")
    return ivalue


def validate_writable_dir(path: str) -> str:
    """Resolve ``path`` to an absolute dir, create it, and verify writability.

    Creates the directory (parents included) if absent, confirms it is a
    directory, and confirms the process can write to it. Does NOT require
    containment under the project root — user paths like ~/Downloads are fine.

    Returns the resolved absolute path string. Raises PermissionError if the
    path is not a writable directory.
    """
    if "\x00" in path:
        raise PermissionError(f"out_dir is not a writable directory: {path}")
    resolved = os.path.abspath(path)
    try:
        os.makedirs(resolved, exist_ok=True)
        if not os.path.isdir(resolved):
            raise PermissionError(f"out_dir is not a writable directory: {path}")
        if not os.access(resolved, os.W_OK):
            raise PermissionError(f"out_dir is not a writable directory: {path}")
    except OSError as e:
        raise PermissionError(f"out_dir is not a writable directory: {path}") from e
    return resolved
