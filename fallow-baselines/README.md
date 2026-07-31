# Fallow baselines

Committed debt ledger for staged Fallow adoption (issue #92 / ADR-0017).

| File | Produced by |
| --- | --- |
| `dead-code.json` | `fallow dead-code --save-baseline` |
| `health.json` | `fallow health --save-baseline` |
| `dupes.json` | `fallow dupes --save-baseline` |

Regenerate after an intentional debt-reduction pass:

```bash
npm run fallow:baselines
```

`fallow audit` (via `.fallowrc.json` `audit.*Baseline` paths) uses these so
**inherited** findings on touched files do not dominate the PR verdict.
**New** findings still fail.

## Deferred baseline debt

| Category | Items | Follow-up |
| --- | --- | --- |
| Unused UI kit files | `flight-status-card`, `scroll-island*`, `skiper-ui/*`, `switch` | [#98](https://github.com/rps321321/san-citro/issues/98) |
| Complexity hotspots | large route components (`settings`, `library`, `reader`, `downloads`, …) | separate deepen tickets as needed |
| Class members | `PythonBridge` helpers never referenced externally | leave until bridge API is narrowed |
| Cross-surface titlebar clone | `electron-app/src/titlebar.ts` ↔ `web/src/lib/titlebar.ts` | intentional contract mirror; do not invent a shared package solely for this |

Baseline growth requires explicit review. Prefer deletion / consolidation over
extending this ledger.
