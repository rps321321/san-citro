import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from rich.logging import RichHandler

# Resolve log file path relative to project root (one level up from src/)
_LOG_DIR = Path(__file__).parent.parent
_LOG_FILE = _LOG_DIR / "annas_archive.log"


def setup_logging(verbose: bool = False, log_file: str = "") -> logging.Logger:
    """
    Configures professional logging for the toolkit.
    Uses Rich for beautiful console output and a rotating file handler for persistence.
    """
    level = logging.DEBUG if verbose else logging.INFO
    resolved_log_file = log_file or str(_LOG_FILE)

    # Root Logger Setup
    logger = logging.getLogger("annas_archive")
    logger.setLevel(logging.DEBUG)
    logger.handlers = []  # Clear existing handlers to prevent duplicates

    # Rich Console Handler (for user feedback)
    console_handler = RichHandler(
        rich_tracebacks=True,
        markup=True,
        show_path=False,
    )
    console_handler.setLevel(level)

    # Rotating File Handler (5 MB max, keep 3 backups)
    try:
        file_handler = RotatingFileHandler(
            resolved_log_file,
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - [%(filename)s:%(lineno)d] - %(message)s"
        )
        file_handler.setFormatter(file_formatter)
        logger.addHandler(file_handler)
    except OSError as e:
        # If log file can't be created (e.g., permissions), warn and continue with console only
        import sys

        print(f"WARNING: Could not create log file {resolved_log_file}: {e}", file=sys.stderr)

    logger.addHandler(console_handler)

    # Mute noisy 3rd party libraries
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("selenium").setLevel(logging.WARNING)

    return logger


def get_logger() -> logging.Logger:
    """Retrieves the pre-configured logger."""
    return logging.getLogger("annas_archive")
