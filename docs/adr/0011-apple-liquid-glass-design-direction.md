# The visual language is refined Apple "Liquid Glass"

> **Superseded (visual direction).** Product visual language is now defined by
> [ADR-0016](0016-desktop-visual-language.md) — warm, precise **Windows desktop library utility**.
> Apple / Liquid Glass as north star is retired. Mechanics that still apply (citrus accent,
> shell translucency vs opaque content, blur budget / containing-block trap, light+dark) are
> restated in 0016. Keep this file for historical context only.

San Citro's UI adopts Apple's design philosophy (clarity · deference · depth) and the
**Liquid Glass** material language, executed as a *refined Mac app* — not the playful,
maximalist component-kit look first explored in [the frontend-revamp goal](../plans/frontend-revamp.md).
The Apple aesthetic is the **north star**; the component kit (watermelon / componentry /
cult-ui / dotmatrix / skiper) becomes a **parts-bin** drawn from only where a part clears
the refined bar.

**Decisions:**

- **Direction.** Refined Mac app: Apple philosophy + Liquid Glass materials, restraint,
  precise spacing rhythm, spring-based motion. No gooey/particle/circuit-board maximalism.
- **Accent.** A single **citrus orange** (from the logo), used with Apple restraint — the
  active nav item, primary buttons, focus rings, the playing chapter highlight. Glass +
  system grays carry everything else. (Not Apple system blue; the citrus is the brand.)
- **Materials.** Glass lives on the **control/chrome layer** ([[control-layer-vs-content-layer]])
  — sidebar, toolbars, sheets, popovers, dropdowns, the expanded player, the status island —
  which floats *above* content; the **content layer** (lists, cards, the library/reading
  surface) stays **solid and legible**. This mirrors Apple's actual Liquid Glass usage.
  On Windows the glass is *approximated*: **Mica** at the window level (the sidebar, done)
  + **CSS `backdrop-filter`** for in-app overlays. True Apple refraction isn't available.

## Considered options

- **Playful component-kit maximalism** (gooey menus, cursor-particle typography, circuit
  boards, flight-status cards) — REJECTED: clashes with refined Apple restraint. The kit is
  now a parts-bin, not the aesthetic; each component is filtered through the refined bar.
- **Apple system blue accent** — rejected: abandons the citrus brand identity.
- **Glass on every surface (content too)** — rejected: text-over-wallpaper legibility and
  visual clutter; not how Apple actually applies Liquid Glass.

## Consequences

- Component picks are re-judged against the refined bar (resolved in a follow-up ADR): likely
  *keep* the ones that read as Apple — scroll-island ≈ Dynamic Island, discrete-tabs ≈
  segmented control, dropdown-disclosure, adaptive-slider — and *drop* the clashing ones.
- Motion becomes **spring-based** (Apple easing), not generic 200ms tweens.
- A `--glass-*` token set + a reusable glass surface utility (translucent bg + `backdrop-blur`
  + hairline border + soft shadow) is needed; `--primary`/accent tokens shift to the citrus.
- **Glass performance — full glass now, optimize later (decided 2026-06-29).** Glass goes on the
  whole control layer *and* animates (player morph, island expand), despite `backdrop-filter` blur
  being GPU-heavy and animated blur being its worst case (research: [shadcn #327](https://github.com/shadcn-ui/ui/issues/327),
  [FoundryVTT #10400](https://github.com/foundryvtt/foundryvtt/issues/10400)). Risk accepted to keep
  the vision intact. **Trigger:** after the shell + player land, profile on a *normal laptop* (not the
  dev GPU). If frames drop, optimize hotspots in this order — animated-blur morphs first (cross-fade a
  pre-blurred static layer instead of re-blurring per frame), then cap simultaneous CSS-blur surfaces,
  then let Mica carry the always-on sidebar. Fake-glass (gradient/no-blur) is the last-resort fallback.
- Glossary: [[liquid-glass]], [[control-layer-vs-content-layer]], [[citrus-accent]].
