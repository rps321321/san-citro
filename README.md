# Anna's Archive Toolkit

A production-ready Python CLI for searching and downloading from Anna's Archive via bulk metadata dumps. Minimizes live server load by ingesting `.jsonl.zst` data dumps into a local SQLite database with FTS5 full-text search.

## Requirements

- Python 3.11+
- Chrome/Chromium installed (downloads drive a real browser to pass anti-bot checks)
- VPN/proxy optional — only needed if your IP is blocked by the mirrors

## Installation

```bash
pip install -r requirements.txt

# For download features (Selenium/Chrome):
pip install -r requirements-dev.txt

# Or install as a package:
pip install -e ".[dev]"
```

## Configuration

Copy the example config and edit it:

```bash
cp src/annas_config.example.json src/annas_config.json
```

Config fields:
- `db_path` — Path to your SQLite database
- `out_dir` — Download output directory
- `concurrency` — Parallel download limit
- `proxies` — List of proxy addresses (optional)

## CLI Commands

```bash
python src/cli.py <command> [options]
```

| Command | Description |
|---------|-------------|
| `init` | Set default configuration |
| `fetch` | Discover latest metadata dump magnet links |
| `search <query>` | Search local database (FTS5) |
| `snatch <query>` | Interactive search + multi-select download |
| `batch-snatch <file>` | Process a wishlist file for batch downloads |
| `download <md5>` | Direct download by MD5 hash |
| `diagnose` | Run system health checks (network, DB, Chrome) |
| `optimize` | VACUUM and optimize the database |
| `stats` | Show database statistics |
| `refresh-proxies` | Fetch fresh proxy list |

### Global Flags

- `--verbose` — Enable DEBUG-level logging
- `--direct` — Bypass proxy logic and connect directly

## Data Pipeline

1. **Fetch** — `cli.py fetch` discovers latest `.jsonl.zst` dump and outputs a magnet link
2. **Download** — Use a torrent client to download the metadata dump
3. **Ingest** — Stream-decompress and load into SQLite with FTS5 indexing
4. **Search** — Query locally with full-text search, no live server hits
5. **Download Books** — Automated Chrome-based downloads with MD5 verification

## Testing

```bash
# Install dev dependencies
pip install -r requirements-dev.txt

# Run all tests
pytest

# With verbose output
pytest -v
```

All tests are fully offline (mocked HTTP). No VPN or network access required.

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
├── electron-app/               # Electron desktop app
│   ├── src/                    # main / preload / ipc-handlers (TypeScript)
│   └── python/                 # JSON-RPC bridge over src/
├── web/                        # Next.js renderer (loaded by Electron)
├── requirements.txt            # Production dependencies
├── pyproject.toml              # Package configuration
└── .gitignore
```
