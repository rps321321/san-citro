# Anna's Archive Toolkit / San Citro

Search and download from Anna's Archive via **live scraping** — no bulk metadata
dumps or local archive database required. Ships in two forms that share one
Python core (`src/`):

- **CLI** (`src/cli.py`) — search, snatch, and download from the terminal.
- **San Citro** — an Electron desktop app whose Next.js renderer (`web/`) talks
  to the Python core over a JSON-RPC bridge (`electron-app/python/`). No HTTP server.

Downloads drive a real Chrome browser (with `curl_cffi` TLS impersonation) to
get past Anna's Archive's anti-bot checks. Completed downloads are recorded in a
local SQLite history database.

## R&D Telemetry Rule

This is a personal-use app, and the analytics stack is intentional R&D infrastructure. Search/download telemetry, session replay, heatmaps, frustration signals, and related Supabase event capture are required in the best-state development build unless Raghav explicitly says otherwise.

Do not remove, disable, or "simplify away" analytics as unused bloat during cleanup. Fix bugs around it, document its behavior, and keep credentials out of source control.

## Requirements

- Python 3.11+
- Chrome/Chromium installed (downloads drive a real browser to pass anti-bot checks)
- VPN/proxy optional — only needed if your IP is blocked by the mirrors

## Installation

```bash
# Install the package with its dev dependencies (pytest, ruff, mypy, …):
pip install -e ".[dev]"
```

There is no `requirements.txt`; all dependencies are declared in `pyproject.toml`.
Chrome automation (`undetected-chromedriver`, `selenium`) and TLS impersonation
(`curl_cffi`) are core dependencies, so a plain install is download-ready.

## Configuration

Settings live in a JSON file under the platform config directory
(`%APPDATA%/san-citro` on Windows, `~/.config/san-citro` on Linux,
`~/Library/Application Support/san-citro` on macOS). It is created on first use;
the desktop app's **Settings** page edits it, or pass `--config PATH` to the CLI.

Config fields:
- `out_dir` — download output directory
- `concurrency` — parallel download limit (1–32)
- `proxies` — list of proxy URLs (optional)
- `base_url` — pin an Anna's Archive domain (omit/`null` to auto-detect)
- `history_db` — download-history DB path (omit/`null` for the platform data dir)

## CLI Commands

```bash
python -m src <command> [options]     # or: annas-archive <command> [options]
```

| Command | Description |
|---------|-------------|
| `search <query>` | Search Anna's Archive (live scraping) |
| `snatch <query>` | Interactive search + multi-select download |
| `batch-snatch <file>` | Process a wishlist file (queries and/or MD5 hashes) |
| `download <md5>` | Direct download by MD5 hash |
| `fetch` | Discover the latest metadata-dump magnet link |
| `history` | Show recent download history |
| `diagnose` | Run system health checks (internet, IP, reachability, Chrome, TLS, proxies) |

### Global Flags

- `--verbose` — enable DEBUG-level logging
- `--direct` — bypass all proxy logic and connect directly
- `--config PATH` — override the config file path
- `--concurrency N` — override the parallel download limit
- `--strategy {chrome,direct}` — download strategy (default: `chrome`)

## Testing

```bash
pip install -e ".[dev]"

# Run all tests
pytest

# With verbose output
pytest -v
```

All tests are fully offline (network mocked). No VPN or network access required.

## Project Structure

```
annas_archive_project/
├── src/                        # Python core (CLI + shared download engine)
│   ├── annas_archive_tool.py   # HTTP client + download automation (MD5 verify, resume)
│   ├── cli.py                  # CLI entry point
│   ├── scraper.py              # Live Anna's Archive search scraper
│   ├── download_strategy.py    # Chrome / DirectHTTP download strategies
│   ├── download_job.py         # Shared download lifecycle (CLI + Electron)
│   ├── download_history.py     # SQLite download history
│   ├── config_manager.py       # JSON config management
│   ├── diagnostics.py          # System health checks
│   ├── migrations.py           # SQLite schema migrations
│   ├── export.py               # Search-result exporters
│   ├── logger.py               # Logging setup (Rich + rotating file)
│   ├── shutdown.py             # Graceful SIGINT/SIGTERM handling
│   ├── utils.py                # Shared helpers (domains, rate limiting)
│   └── mock_data_generator.py  # Test fixture generator
├── tests/                      # pytest suite (offline, mocked network)
├── electron-app/               # Electron desktop app (San Citro)
│   ├── src/                    # main / preload / ipc-handlers (TypeScript)
│   └── python/                 # JSON-RPC bridge over src/
├── web/                        # Next.js renderer (loaded by Electron)
└── pyproject.toml              # Package + dependency configuration
```
