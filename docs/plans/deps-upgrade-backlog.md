# Dependency upgrade backlog

Scored decisions from the regenerable inventory dump. **This file is the durable product.** The full trees and raw advisories live under `.cache/deps-inventory/` (gitignored).

## Security decision log — #88 (2026-07-31)

| Package | Old constraint | New constraint | Advisory | Min fixed |
|---|---|---|---|---|
| `tqdm` (prod) | `~=4.65.0` → installed 4.65.2 | `>=4.66.3,<5` | `PYSEC-2026-1976` | 4.66.3 |
| `pytest` (dev) | `~=7.4.0` → installed 7.4.4 | `>=9.0.3,<10` | `PYSEC-2026-1845` | 9.0.3 |
| `pytest-mock` (dev) | `~=3.12.0` | `>=3.14.0,<4` | pytest 9 compatibility | — |
| `pytest-cov` (dev) | CI-only install | `>=6.0.0,<7` | declare what CI uses | — |
| `setuptools` (build + dev) | `>=68.0` / env default | `>=78.1.1` | PYSEC-2025-49 and related | 78.1.1+ |

- **Policy:** one authoritative `pyproject.toml`; no CI-only patched installs; no `--ignore-vuln`.
- **Evidence:** full `pytest` suite (471) + ruff + clean-venv `pip-audit` after `pip install -e ".[dev]"` (no third-party vulns; local package not-on-PyPI is informational).
- **Resolved versions (clean venv sample):** pytest 9.1.1 · tqdm 4.70.0 · pytest-mock 3.15.1 · pytest-cov 6.3.0.
- **Non-goals of this change:** general modernization; Ruff/mypy/Selenium bumps.

| | |
|---|---|
| Generated from dump | **2026-07-30T17:27:05.982256+00:00** (`meta.json` `generated_at`) |
| Source paths | `.cache/deps-inventory/meta.json`, `normalized.json`, per-surface `*/{tree,outdated,audit,package-meta}.json` (python: `pip_list` + `audit`) |
| Dump stats | **124** normalized rows; **14** high; **0** critical; **3** python moderate (`pip-audit`) |
| Toolchain at dump | Node v24.13.0 · npm 11.16.0 · Python 3.11.9 |
| Regenerator | `python scripts/deps_inventory.py` or `make deps-inventory` |
| Cadence | On demand + **before each Release tag** |
| Scope | Python + `electron-app` + `web` package graphs only |
| Non-goals (of inventory itself) | Blind bulk upgrades; binaries; vendored foliate-js; CI fail-on-vuln |
| First do-now wave | Applied: remove `epubjs`; next/eslint-config-next **16.2.12**; react-router **^8.3.0**; requests **~=2.33.0** |

---

## How to regenerate the dump

```bash
python scripts/deps_inventory.py
# or
make deps-inventory
```

| Flag | Purpose |
|---|---|
| `--out DIR` | Override dump directory (default `.cache/deps-inventory`) |
| `--skip-python` | Skip temp-venv resolve + pip-audit (multi-minute) |
| `--skip-npm` | Skip both npm surfaces |
| `--skip-web` / `--skip-electron` | Skip one npm surface |

| Output | Path |
|---|---|
| Meta + tool versions | `.cache/deps-inventory/meta.json` |
| Flat scored-ready rows | `.cache/deps-inventory/normalized.json` |
| Per-surface tree / outdated / audit | `.cache/deps-inventory/{web,electron-app,python}/` |

**Python note:** each full run creates a **temp venv**, `pip install -e ".[dev]"`, then `pipdeptree` + `pip-audit`. That is “what a clean install gets today,” not your global site-packages. There is **no Python lockfile** yet (see follow-ups).

**npm note:** `npm outdated` / `npm audit` often exit non-zero when findings exist; the script treats that as success if JSON parsed.

**After regenerating:** re-triage effort/buckets in this file (machine fills `severity` / `outdatedness` / `score_effort1` only).

---

## Scoring rubric

```
score = (severity_score × outdatedness) / effort
```

| severity | score |
|---|---|
| none | 1 |
| low | 2 |
| moderate | 4 |
| high | 8 |
| critical | 16 |

| outdatedness | score |
|---|---|
| current / patch | 1 |
| minor | 2 |
| major | 4 (+1 per extra major behind, cap 8) |
| unknown delta | 2 |

| effort | score | meaning |
|---|---|---|
| S | 1 | patch/minor or **delete unused direct**; tests only |
| M | 2 | API/lock churn, SPA routing, modest regression surface |
| L | 4 | framework/test-runner major, packaging-adjacent |
| XL | 8 | selenium/chromedriver/anti-bot, electron-builder deep, full package smoke + manual download path |

**Machine fills** severity + outdatedness (see `normalized.json` `score_effort1` = formula with effort=1).  
**Human/agent fills** effort + bucket; overrides allowed and should be noted in the effort log.

### Buckets

| Bucket | Meaning |
|---|---|
| `do-now` | Safe, high value; do in a small dedicated PR |
| `soon` | Worth a near-term PR; slightly more risk or cascade |
| `defer` | Real item, not urgent; revisit next inventory |
| `never` | Won’t do (document why) |

### Inclusion rules for this file

1. **All high/critical** advisory rows (even if effort XL tanks score).  
2. **Top ~15 by score** after effort (union with #1; deduped).  
3. Python `pip-audit` hits (severity often omitted upstream → treated as **≥ moderate**).  
4. Explicit **follow-up candidates** (lockfile, version identity, binaries/vendored).

---

## Executive snapshot (this dump)

| Surface | Signal |
|---|---|
| **web** | 11 high (npm audit); direct highs: **next** 16.2.9→16.2.12 (patch), **react-router** 8.0.1→8.3.0 (minor), **epubjs** 0.3.93 (unused) |
| **electron-app** | 3 high, all **transitive** (brace-expansion, fast-uri, js-yaml); electron **42.5.0 → 43.2.0** major available |
| **python** | 3 `pip-audit` hits (no severity field → **moderate**): **requests** 2.32.5, **tqdm** 4.65.2, **pytest** 7.4.4 |
| **Dead direct dep** | `epubjs` is in `web/package.json` but **unused** — reader uses vendored **foliate-js** (`web/src/vendor/foliate-js`, ADR-0014; `reader.tsx` imports only foliate) |
| **Critical** | **none** |

Package version identity drift (follow-up F2): electron-app **1.2.0** (shipped), web **0.1.0**, pyproject **0.1.0**.

---

## Ranked backlog

Scores use the rubric above applied to this dump’s `score_effort1` ÷ human effort. Advisory IDs are npm audit `source` ids or GHSA/CVE/PYSEC from pip-audit.

### `do-now` (applied)

| Rank | Package | Surface | Sev | Od | Effort | Score | Action | Notes / assumptions |
|---|---|---|---|---|---|---|---|---|
| 1 | **epubjs** (+ `@xmldom/xmldom`) | web | high | 1 | **S** | **8** | **DONE — removed** | Foliate-js is the reader (ADR-0014). |
| 2 | **next** (+ postcss, sharp cascade) | web | high | 1 (patch) | **S** | **8** | **DONE — 16.2.12** (+ `eslint-config-next`) | Installed **16.2.12**. npm audit may still flag next with a noisy major-downgrade “fix”. |
| 3 | **react-router** | web | high | 2 (minor) | **M** | **8** | **DONE — ^8.3.0** | path-to-regexp high may remain via **shadcn → express** (not react-router). |
| 4 | **requests** | python | mod | 1 | **S** | **4** | **DONE — ~=2.33.0** | Pin allows 2.33.x. |

### `soon`

| Rank | Package | Surface | Sev | Od | Effort | Score | Action | Notes / assumptions |
|---|---|---|---|---|---|---|---|---|
| 5 | **tqdm** | python | mod | 1 | **S** | **4** | Bump to **≥4.66.3** | Installed **4.65.2**. CVE-2024-34062 / GHSA-g7vv-2v7x-gj9p — `eval` on CLI args. Library import path is lower risk than `python -m tqdm`, but pin is cheap. |
| 6 | **path-to-regexp** | web | high | 1 | **S** | **8** | Prefer **via react-router** bump; verify audit clean | High (sources 1115573/1115582). Not a direct dep. Track as cascade check after #3. |
| 7 | **postcss**, **sharp** | web | high | 1 | **S** | **8** | Prefer **via next** 16.2.12 | High via next tree. Track as cascade checks after #2, not separate majors. |
| 8 | **@xmldom/xmldom** | web | high | 1 | **S** | **8** | Prefer **via epubjs removal** | Sources 1117097/1117894/1117897. Should disappear when epubjs is removed. |
| 9 | **hono** (+ `@hono/node-server`) | web | high/mod | 1 | **M** | **4** | Bump **shadcn** / lock refresh; re-audit | Transitive (CLI/tooling). Desktop static export may not hit hono at runtime — still clear audit noise. |
| 10 | **js-yaml**, **brace-expansion**, **fast-uri** | web + electron-app | high | 1 | **M–L** | **2–4** | npm overrides **or** parent bumps (`electron-builder` / tooling) | Electron highs are **dev/packaging tree**. Runtime app deps are tiny (`electron-log`, `electron-updater`). **Assumption:** packaged user app does not ship these if only in devDependency tree — verify with `npm ls` before panic. |
| 11 | **pytest** | python | mod | 1 | **L** | **1** | Plan pytest **7 → 8/9** wave | Installed **7.4.4**. CVE-2025-71176 / GHSA-6w46-j5rx-g56g — `/tmp/pytest-of-{user}` (UNIX). Primary dev OS here is **Windows** → lower urgency. Fix versions list **9.0.3**. |
| 12 | Minor hygiene (web) | web | none | 1–2 | **S** | **1–2** | `@tailwindcss/postcss`, `tailwindcss`, `lucide-react`, `framer-motion`/`motion`, `@types/*`, `rrweb` patch, `shadcn` | No advisories in this dump; pure bitrot prevention. Batch after security bumps. |

### `defer`

| Rank | Package | Surface | Sev | Od | Effort | Score | Action | Notes / assumptions |
|---|---|---|---|---|---|---|---|---|
| 13 | **electron** | electron-app | none | 4 (42.5→43.2) | **L** | **1** | Major bump when ready for package smoke | Needs full Windows package smoke + updater path (ADR-0015). |
| 14 | **typescript** | web + electron-app | none | 4 (6.0.3→7.0.2) | **L** | **1** | Major language bump | Coordinate both packages; expect type churn. |
| 15 | **eslint** 9 → 10 | web | none | 4 (9.39→10.8) | **L** | **1** | Flat-config already on 9; major later | Wanted stays on 9.x; latest is 10. |
| 16 | electron-builder transitive highs | electron-app | high | 1 | **L–XL** | **1–2** | Wait for upstream builder releases; avoid manual overrides unless shipping risk proven | **Assumption:** XL if rebuild/native issues appear. |
| 17 | **selenium** / **undetected-chromedriver** / **curl_cffi** | python | none* | varies | **XL** | **—** | Only touch for feature/anti-bot breakage | *No pip-audit hits this run. Highest product risk if upgraded casually. |

### `never` (this cycle)

| Item | Why |
|---|---|
| Blind `npm update` / `pip install -U` everything | Violates inventory-first plan; anti-bot + packaging blast radius |
| CI red on any advisory | Policy change; needs explicit ADR if desired later |
| Dependabot / Renovate as default | Ongoing policy, not this inventory (see F5) |

---

## High / critical checklist (must not drop off)

**Web (high):** `next`, `react-router`, `epubjs`, `@xmldom/xmldom`, `path-to-regexp`, `postcss`, `sharp`, `hono`, `brace-expansion`, `fast-uri`, `js-yaml`

**Electron-app (high):** `brace-expansion`, `fast-uri`, `js-yaml`

**Critical:** **none** in this dump.

**Python (moderate via pip-audit — included even though not “high”):**

| Package | Installed | Advisories | Fix ≥ |
|---|---|---|---|
| `requests` | 2.32.5 | CVE-2026-25645, GHSA-gc5v-m9x4-r6x2, PYSEC-2026-2275 | 2.33.0 |
| `tqdm` | 4.65.2 | CVE-2024-34062, GHSA-g7vv-2v7x-gj9p, PYSEC-2026-1976 | 4.66.3 |
| `pytest` | 7.4.4 | CVE-2025-71176, GHSA-6w46-j5rx-g56g, PYSEC-2026-1845 | 9.0.3 |

---

## Follow-up candidates (not inventory work)

| ID | Candidate | Why separate |
|---|---|---|
| F1 | **Introduce a Python lockfile** (`uv.lock` / pip-tools / etc.) | Makes Python full-tree reproducible; inventory today uses throwaway resolve |
| F2 | **Package version identity** | `electron-app` **1.2.0** is the shipped app; `web` and `pyproject` still **0.1.0**. Release tags key off Electron + `vX.Y.Z` (ADR-0015). Decide: inherit at build, mark private, or sync |
| F3 | **Bundled binaries / PyInstaller freeze / foliate-js vendor pin** | Out of v1 inventory scope; real bitrot surfaces (`electron-app/bin`, `python-dist`, `web/src/vendor/foliate-js`) |
| F4 | **Makefile `install` target** | Uses `pip install -e ".[dev]"` (not a missing `requirements-dev.txt`). Further Makefile Unix-isms (`rm -rf` in `clean`) left alone |
| F5 | Dependabot / Renovate / CI fail-on-advisory | Explicit policy later; **not** enabled by this work |

---

## First upgrade wave — done

Applied on master (same wave as this note):

1. Removed **epubjs** from `web` (+ lockfile).  
2. Bumped **next** + **eslint-config-next** → 16.2.12.  
3. Bumped **react-router** → ^8.3.0.  
4. Bumped **requests** → ~=2.33.0 in `pyproject.toml`.

**Gates run:** web unit + component tests green; `python -m pytest` 424 passed. Remaining web highs are mostly transitive (shadcn/tooling) — see `soon`.

---

## Effort-assignment log (first pass)

| Who | When | Notes |
|---|---|---|
| Agent (ticket #40) | 2026-07-30 | Filled from dump `generated_at=2026-07-30T17:27:05Z` + codebase checks (`epubjs` unused; reader = foliate-js). Normalized rebuilt to include python surface rows that were on disk. XL anti-bot stack not scored into top 15. Human override welcome on react-router (M vs S) and electron transitive (M vs L). |

---

## Out of scope reminder

- No production version bumps landed with the inventory tooling itself.  
- No Dependabot / Renovate / CI fail-on-advisory policy.  
- No GH issue required until a wave is executed (then open issues per wave if desired).  
- Re-triage: regenerate dump → refresh scores → edit this file’s buckets.
