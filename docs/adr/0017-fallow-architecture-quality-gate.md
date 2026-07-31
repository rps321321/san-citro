# Fallow owns TypeScript architecture and changed-code graph quality

San Citro’s TypeScript surfaces (`web/`, `electron-app/`) need a **single deep
architecture-quality boundary** (Ousterhout): dead code, cycles, duplication,
complexity hotspots, and import-direction drift must not be left to scattered
reviewer intuition or treated as another shallow warning stream.

This record does **not** replace ESLint, TypeScript, Vitest, package smoke, or
Python Ruff/mypy/pytest/pip-audit. Each tool keeps a sharp ownership slice.

## Decision

Adopt **Fallow** (`fallow` npm package, pinned at the repository root) as the
authoritative TypeScript **module-graph** quality gate.

### Ownership matrix

| Concern | Owner | Not responsible for |
| --- | --- | --- |
| Module graph: unused files/exports, cycles, architecture zones, duplication, complexity hotspots on changed code | **Fallow** | Style, types, runtime behaviour |
| File-local style, React hooks rules, import sorting noise | **ESLint** | Cross-file reachability |
| Type correctness, public contracts | **TypeScript (`tsc`)** | Whether a typed export is reachable |
| Behaviour and regression contracts | **Vitest / node:test / package-smoke / pytest** | Structural debt |
| Python style/types/tests/security | **Ruff / mypy / pytest / pip-audit** | TS/JS graph |

### Install boundary

- Root `package.json` is the **only** Fallow version owner (devDependency + lockfile).
- Do **not** dual-pin `fallow` in `web/package.json` or `electron-app/package.json`.
- No monorepo framework conversion is required; Fallow analyzes both surfaces from the repo root.

### Config and baselines

- Policy: [`.fallowrc.json`](../../.fallowrc.json)
- Regenerable debt ledger: [`fallow-baselines/`](../../fallow-baselines/)
  - `npm run fallow:baselines` rewrites dead-code / health / dupes baselines
- Machine-local cache: `.fallow/` (gitignored)

### Architecture zones (smallest set that expresses real ownership)

| Zone | Paths | May import |
| --- | --- | --- |
| `web-domain` | `web/src/lib/**`, `web/src/types/**` | (isolated — no React routes/components) |
| `web-ui-primitives` | `web/src/components/ui/**` | `web-domain` only |
| `web-features` | components (non-ui), routes, hooks, contexts, app | `web-domain`, `web-ui-primitives` |
| `web-test` | tests + `web/src/test/**` | domain, ui, features |
| `electron-main` | `electron-app/src/**` | isolated (no renderer imports) |
| `electron-scripts` | `electron-app/scripts/**` | isolated |

Cross-surface rule: renderer and Electron main are separate zones; neither may
import the other. IPC/preload remain the contract boundary.

### Scripts

| Script | Command |
| --- | --- |
| Full combined scan | `npm run fallow` / `npm run fallow:scan` |
| Dead code | `npm run fallow:dead-code` |
| Duplication | `npm run fallow:dupes` |
| Health | `npm run fallow:health` |
| Changed-code gate | `npm run fallow:audit` |
| Refresh baselines | `npm run fallow:baselines` |

CI job **Fallow architecture audit** runs `npm ci` at the root and
`npm run fallow:audit` with `gate: new-only` so pre-existing baselined debt does
not block PRs, while **new** dead code, cycles, disallowed edges, duplication, or
health regressions fail the job.

### Review policy for findings

1. **Delete** code proven unused.
2. **Consolidate** duplication into the module that already owns the policy.
3. **Deepen** a shallow module so callers stop repeating its decisions.
4. **Break a cycle** by moving the shared abstraction to the conceptual owner
   (not a catch-all `utils` dump).
5. **Baseline** only when cleanup is too large for the current change — and open
   a concrete follow-up issue. Baseline growth requires explicit review.

Do not:

- suppress whole directories to force green results
- add re-export barrels that hide dependency direction
- mechanically split functions solely to lower a complexity number
- use `continue-on-error` on the Fallow CI job

### Exclusions

Exclude only generated/vendor/build outputs:

`node_modules`, `.next`, `out`, `dist`, `release`, renderer build copies,
python-dist/build, snapshots/test-artifacts, and vendored `web/src/vendor/**`
(third-party foliate-js). Product source stays in scope.

## Consequences

- Contributors and agents run one stable command before merge: `npm run fallow:audit`.
- Architecture boundaries are encoded, not tribal knowledge.
- Existing debt is visible and bounded under `fallow-baselines/`.
- Issue follow-ups own deferred kit cleanup (unused landing UI primitives) rather
  than hiding them with broad ignores. Deferred kit cleanup: [#98](https://github.com/rps321321/san-citro/issues/98).
