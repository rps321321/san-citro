import json
import os
from pathlib import Path
from typing import Optional, List, Any, Dict

# Resolve config path relative to this file's directory, not CWD
CONFIG_PATH = Path(__file__).parent / "annas_config.json"


def get_config() -> Dict[str, Any]:
    """Load settings from the local config file with default fallbacks."""
    defaults: Dict[str, Any] = {
        "db_path": None,
        "out_dir": "downloads",
        "concurrency": 2,
        "proxies": [],
    }
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r") as f:
                config = json.load(f)
            return {**defaults, **config}
        except (json.JSONDecodeError, OSError) as e:
            import logging
            logging.getLogger("annas_archive").warning(
                f"Config file is corrupt or unreadable ({CONFIG_PATH}): {e} — using defaults"
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

    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=4)
    return config
