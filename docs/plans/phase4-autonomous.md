# Phase 4 — Autonomous surface reskin (overnight run)

**Mission.** Build the Phase-4 Apple-glass surface reskin **autonomously**, committing each
surface, while the user is asleep. Make tasteful, conservative decisions per ADR-0011; never block.

## Hard rules (autonomous mode — the user is NOT available)
- **No questions, no waiting, no desktop screenshots** (can't see the screen; it surfaces the
  user's private windows). Decide and proceed.
- Stay on branch **`feat/latest-stack`**. NEVER touch `master`. NEVER publish/release. NEVER force-push.
- **One surface = one commit.** The branch must build at every commit — never leave it broken. If a
  surface gets stuck, `git checkout` the changes away, log it, move to the next.
- **Verify before every commit:** `web` build + `tsc` (web *and* electron) + `lint` all green. For the
  player, the dev-log RPC check (`save_audiobook_progress` etc.). For routing/logic, a temp self-test
  harness (revert it after). Visual surfaces can't be self-verified — flag them "needs visual review"
  in the Progress log; keep the changes **conservative + reversible** so morning review is low-risk.
- **Decision policy:** when a choice arises, pick the option most consistent with ADR-0011 (refined
  Apple, *single* citrus accent, glass on the control layer only, restraint, spring motion) + the
  "Surface designs" in `frontend-revamp.md`. Put the decision in the commit message. Keep moving.
- **Use the Phase-3 design system:** the `.glass` utility, citrus tokens, `lib/motion.ts` springs,
  type metrics. Respect the **glass-killer trap** — never put `backdrop-filter` inside a Motion
  transform/layout-animated ancestor (cross-fade a pre-blurred sibling instead).
- **Budget-aware:** commit frequently; if context/token budget runs low, finish the current surface,
  update the Progress log, schedule one more wakeup or stop cleanly. Prefer small diffs.

## Build order — most-visible first (so the app looks transformed by morning)
1. **Sidebar + chrome polish + citrus active-nav** — active nav item gets a citrus indicator/tint;
   refine the header strip; tighten spacing. High visibility, low risk.
2. **Library cover grid** — covers as hero (rounded, soft shadow, title/author below), hover lift +
   citrus selection ring, staggered grid entrance (`springSmooth`). The most-visible surface.
3. **Dynamic Island** — wire the installed `scroll-island` into the title-bar center: idle glass pill
   → expands on activity (subscribe to `onDownloadProgress` + `onAudiobookStatus`) → settles.
4. **Detail sheet** — click a cover → a `.glass` sheet (cover, metadata, description, Read/Play/
   Reveal/Delete). Cover shared-element morph via `layoutId` (keep the sheet's glass OUT of the
   morphing transform — glass-killer trap).
5. **Search rows** — task-oriented rows (cover thumb + title/author/year/format/size/lang + inline
   Download), citrus accents; distinct from the Library grid.
6. **Activity** — merge Downloads + History into one "Activity" route + nav item; keep `/downloads`
   and `/history` hash routes redirecting to it.
7. **Player UI polish** — `.glass` mini/expanded, citrus controls, spring transitions (glass-killer
   trap on the mini→expanded morph: cross-fade, don't blur-inside-transform).
8. **Genre shelves + OpenLibrary enrichment** — best-effort; OpenLibrary primary, graceful on miss.
   If it balloons, scaffold + log for the user.
9. **Reader polish** (epub.js theming only). **foliate-js multi-format is a big separate effort —
   DEFER** unless everything else is done with budget to spare; log it either way.

## Per-surface loop
implement → `web` build + tsc×2 + lint green → commit (with the decisions) → append a Progress-log
entry → `ScheduleWakeup` for the next surface → repeat.

## Stop conditions
All surfaces done, OR budget/context low, OR a genuinely blocking issue. On stop: ensure the branch
is green, write the blocker + your recommendation in the Progress log, and stop. Do **not** ask.

## Morning handoff — Progress log (append newest at the bottom)
- 2026-06-29 — Run armed. Done before this run: Phases 0–3 + Ctrl+K palette (commits up to the
  command-palette). Next surface: **#1 sidebar/chrome citrus active-nav**. Visual surfaces will be
  flagged "needs visual review" — please skim the diffs + the live app and send feedback in the morning.
- 2026-06-29 — **#1 sidebar citrus active-nav ✅**. The active nav item now uses a citrus tint
  (`bg-primary/10`) + citrus text/icon (`text-primary`), overriding the neutral `bg-sidebar-accent`.
  Renderer-only; build + lint green. NEEDS VISUAL REVIEW (citrus active state). Next: #2 Library cover grid.
