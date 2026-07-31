# Contributing to San Citro

## One issue → one branch → one PR

1. Sync `master` and branch from the latest tip.
2. Implement **only** the issue you are assigned; do not combine children “for convenience.”
3. Open a PR that includes `Closes #<n>` for that issue only (not parent epics unless verifying completion).
4. **Do not merge with red required checks.** There is no “pre-existing failure ignored” exception — fix the failure or land the prerequisite first.

## Required CI checks (stable names)

Branch protection on `master` must require:

| Check name | Owner |
|---|---|
| `Python lint and format` | Ruff via `pyproject.toml` |
| `Python type check` | mypy via `pyproject.toml` |
| `Python tests (3.11)` | pytest |
| `Python tests (3.12)` | pytest + coverage artifact |
| `Python dependency audit` | pip-audit |
| `Web quality` | `web` `npm run check` + `audit:production` |
| `Electron quality` | `electron-app` `npm run check` |
| `Fallow architecture audit` | root `npm run fallow:audit` |

The branch must be **up to date** with `master` before merge.

## Local commands (same interfaces CI uses)

### Python

```bash
pip install -e ".[dev]"
ruff check src/ tests/
ruff format --check src/ tests/
mypy src/
pytest -q
pip-audit
```

### Web

```bash
cd web
npm ci
npm run check          # lint + typecheck + unit + component + build
npm run audit:production
```

Focused scripts: `lint`, `typecheck`, `test:unit`, `test:component`, `build`.

### Electron

```bash
cd electron-app
npm ci
npm run check          # typecheck + unit discovery + package-smoke
```

Focused: `typecheck`, `test:unit`, `test:package-smoke`.

### Fallow (TypeScript architecture)

```bash
npm ci                 # repo root
npm run fallow:audit -- --base origin/master
```

See `docs/adr/0017-fallow-architecture-quality-gate.md`.

## Security exceptions

Production npm advisories must not use `npm audit fix --force` or framework downgrades. Prefer upstream upgrades or documented package.json overrides (see `docs/plans/deps-upgrade-backlog.md`). Expiring machine-enforced exceptions are last resort (#89 policy).

## Packaged Windows (pre-release, manual)

Before tagging a release, complete a packaged Windows smoke checklist:

- [ ] `npm run build:all` / package produces artifacts matching `package.json` version
- [ ] `npm run package:smoke` (or CI-equivalent fixture) passes against the Release dir
- [ ] App starts; splash hands off to shell without eternal blank frame
- [ ] Native title-bar controls (min/max/close) behave under light and dark
- [ ] Search, Library, Activity, Settings, Reader, In-page player open
- [ ] Download enqueue → Active downloads → terminal retention visible
- [ ] Update check path does not stuck on “available” without Restart when downloaded (packaged only)

This checklist is **not** fully automatable in Linux CI; it remains the pre-release human gate.
