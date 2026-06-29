# San Citro Redesign — Autonomous Execution Goal

**Goal.** Rebuild the renderer into a refined Apple "Liquid Glass" desktop app (Mac look, Windows conventions): hash-routed SPA · in-page persistent player · multi-format reader. Built **autonomously by Claude (Opus 4.8, ultracode)** via agent workflows; human answers only blocking questions. Ship incrementally; `master`/v1.2.0 = rollback. Branch `feat/latest-stack`.

**Canonical decisions — don't relitigate.** ADR-0011 (Liquid Glass + citrus accent) · 0012 (components split by surface) · 0013 (hash SPA + in-page player) · 0014 (foliate-js reader). Surfaces, UX, full build plan: `docs/plans/frontend-revamp.md`. Glossary: `CONTEXT.md`.

**Stack — verified current on npm 2026-06-29.** Next 16.2.9 · React 19.2.7 · TS 6.0.3 · Tailwind v4 · motion 12.42.0 · Electron 42.5.0; bump electron-builder → ^26.15.6. **Add** react-router 8.0.1 (HashRouter; peer React ≥19.2.7 ✓) + sonner 2.0.7 (glass toasts). **Dedupe**: drop `framer-motion`, use only `motion/react` (dual contexts break AnimatePresence/layout). **foliate-js**: no npm → vendor at commit `78914ae` into `web/vendor/foliate-js/` (view.js + 13 parsers + fflate/zip; skip pdfjs, PDF deferred).

**Phases — architecture-first, ship each (bisectable, never long-broken).**
0 Stack ✅ · 1 SPA spike (throwaway) · 2 SPA + in-page player at parity → **SHIP** · 3 design system · 4+ reskin surface-by-surface, ship each · N landing.
- **P1 spike:** `protocol.handle` (drop deprecated `registerFileProtocol`); register scheme `standard+secure+supportFetchAPI` *before app.ready* (standard:true is load-bearing for relative `_next` assets); serve file-else-index.html with path-traversal guard; `HashRouter`. Survive reload + single-instance respawn + deep asset + maximize.
- **P2:** retire WebContentsView; reuse audio + `san-citro-media://`; old look, new architecture.
- **P4+ order:** shell (Dynamic Island · glass toolbar · sidebar · Ctrl+K) → Library (grid · Select-mode · detail-sheet cover-morph · OpenLibrary enrichment · genre shelves) → player UI → search rows → Activity (merge) → foliate reader. Profile glass on a *normal laptop* after shell+player.

**Execution — parallel + model-tiered.** Each phase = a Workflow. **Opus**: architecture, spikes, ADRs, adversarial review, the morph/protocol/glass-critical code. **Sonnet**: surface implementation. **Haiku**: mechanical (icon/token renames, registry installs). Independent surfaces run in **parallel** (worktree isolation when mutating shared files); hard sequential gates between phases. Per surface: implement → adversarial code-review → in-app verify (build + launch + screenshot). Research every dep/API against live sources (npm · Context7 · web · /opensrc) — never training-only; re-verify per phase.

**Hard constraints (researched, must-handle).**
- **Glass-killer trap:** a `transform`/`will-change`/`filter` on ANY ancestor — i.e. *any* Motion layout animation — makes a child's `backdrop-filter` sample nothing → glass *silently vanishes*. So animated glass (player morph, Island expand) MUST cross-fade a **pre-blurred static sibling**, never blur inside a transformed node. Budget ≤3–5 concurrent blurs, radius ≤16px.
- Mica frameless-maximize blackout (#41824/#42393) is **fixed in Electron 42** (PR #45456) — still verify titleBarOverlay+mica in-app.
- **Shared-element:** identical `layoutId` on both nodes; exiting node a keyed `AnimatePresence` child (not Fragment); `layout="position"` for cover→sheet; correct borderRadius/boxShadow via `style`.

**Components (ADR-0012 kept set).** scroll-island + skiper26 in; add discrete-tabs/adaptive-slider/frequency-selector/dropdown-disclosure from the watermelon shadcn registry (per-component install + gotchas in the research notes).

**Done = green every phase:** tsc×2 · lint · web build · in-app launch + screenshot. **Non-goals:** drag-drop import, in-app PDF (both deferred).
