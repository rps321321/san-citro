import json
import logging
import os
import platform
import shutil
from pathlib import Path
from typing import Optional, List, Any, Dict

APP_NAME = "annas-archive"

# Legacy config path (the old location inside src/)
_LEGACY_CONFIG_PATH = Path(__file__).parent / "annas_config.json"

# Module-level override: set by set_config_path() when --config is used
_config_path_override: Optional[Path] = None


def _get_platform_config_dir() -> Path:
    """Return the platform-appropriate config directory using only stdlib.

    - Linux:  $XDG_CONFIG_HOME/annas-archive  (defaults to ~/.config/annas-archive)
    - macOS:  ~/Library/Application Support/annas-archive
    - Windows: %APPDATA%/annas-archive
    """
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
        "db_path": None,
        "out_dir": "downloads",
        "concurrency": 2,
        "proxies": [],
    }

    # Attempt migration from legacy location
    _migrate_legacy_config()

    config_path = get_config_path()
    if config_path.exists():
        try:
            with open(config_path, "r") as f:
                config = json.load(f)
            return {**defaults, **config}
        except (json.JSONDecodeError, OSError) as e:
            logging.getLogger("annas_archive").warning(
                f"Config file is corrupt or unreadable ({config_path}): {e} — using defaults"
            )
            return defaults
    return defaults


def save_config(
    db_path: Optional[str] = None,
    out_dir: Optional[str] = None,
    concurrency: Optional[int] = None,
    proxies: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Save current settings to the config file."""
    config = get_config()
    if db_path is not None:
        config["db_path"] = os.path.abspath(db_path)
    if out_dir is not None:
        config["out_dir"] = out_dir
    if concurrency is not None:
        config["concurrency"] = concurrency
    if proxies is not None:
        config["proxies"] = proxies

    config_path = get_config_path()
    _ensure_config_dir(config_path)
    with open(config_path, "w") as f:
        json.dump(config, f, indent=4)
    return config
