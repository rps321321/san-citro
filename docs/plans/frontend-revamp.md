# Goal — San Citro frontend revamp ("motion-rich chrome + curated component kit")

Transform the San Citro UI from a standard shadcn sidebar app into a polished,
motion-rich desktop experience: **Codex-style translucent (Mica) window chrome**,
a **macOS-style dock** for navigation, and a **curated set of animated components**
(componentry.fun · watermelon.sh · cult-ui · skiper-ui · dotmatrix · device mockups),
plus a **marketing landing page**.

## Why this is feasible (stack verified 2026-06-29)

`web/` is **Next.js 16.2.1 · React 19.2.4 · Tailwind v4 (`@import`, no config) ·
framer-motion/motion v12 · next-themes · shadcn** (`components.json`, style
`base-nova`, baseColor neutral, `@skiper-ui` registry already wired). Every target
library is a **shadcn registry built on the exact same stack** (React 19 + Tailwind
v4 + Framer Motion), so they install drop-in. The libraries' docs/registries are
Cloudflare-bot-protected against `WebFetch`, but the real `npx shadcn add` CLI is
the intended path and is unaffected.

## Component inventory

| Component | Source | Install | Status | Placement in San Citro |
|---|---|---|---|---|
| ~~Dock~~ | cult-ui | — | **dropped** | DROPPED (2026-06-29, accidental) — keep the translucent **sidebar** instead |
| Dropdown Disclosure | watermelon | `…/registry.watermelon.sh/dropdown-disclosure.json` | new | Dropdowns: search filters, sort menus, settings selects |
| Scroll Island | watermelon | (registry) | **installed** | Dynamic-Island status reader — live download/processing status |
| ~~Contextual AI Bar~~ | watermelon | — | **dropped** | DROPPED (2026-06-29) — no AI feature planned |
| Discrete Tabs | watermelon | (registry) | new | Library Books/Audiobooks tabs (replace the plain Buttons) |
| Gooey Menu | watermelon | (registry) | new | Floating quick-actions menu |
| Adaptive Slider | watermelon | (registry) | new | Audiobook scrubber / settings sliders |
| Frequency Selector | watermelon | (registry) | new | Playback-speed / segmented selector |
| Carousel Navigator | watermelon | (registry) | new | Cover carousel (recent/featured in Library) |
| Time Undo Action | watermelon | (registry) | new | Undo for delete (download/audiobook) |
| Profile Card | watermelon | (registry) | new | Settings/account · landing demo |
| Trade Summary | watermelon | (registry) | new | Repurpose → library/history **stats** card · landing demo |
| Shuffle Pinned Item | watermelon | (registry) | new | Pinned/favorite reordering in Library |
| Text Repel | componentry | `shadcn add @componentry/text-repel` | **installed** | Headings / landing hero (already on the logo) |
| Cursor Particle Typography | componentry | `@componentry/cursor-driven-particle-typography` | new | Landing hero title |
| Flight Status Card | componentry | `@componentry/flight-status-card` | **installed** | Repurpose → **download status** card (md5 code, progress, ETA) · or landing |
| Circuit Board | componentry | `@componentry/circuit-board` | new | Landing "how it works" / scraper-pipeline visual |
| Skiper26 toggle | skiper-ui | `@skiper-ui/skiper26` | **installed** | Theme switch (in use; relocate into dock/settings) |
| Dot Matrix loaders | dotmatrix | `@dotmatrix/dotm-…` | new | All loading/skeleton states (search, download, processing) |
| Device mockup | aliimam / shadcn.io | (resolve URL) | new | Landing-page device frame showcasing the app |

**Registries to add to `components.json`** (alongside `@skiper-ui`): the watermelon
URL pattern `https://registry.watermelon.sh/{name}.json`, plus `@componentry`,
`@cult-ui`, `@dotmatrix` (or install via full `/r/{name}.json` URLs).

## Two surfaces

1. **App shell (the Electron renderer):** Mica chrome · dock nav · scroll-island
   status · skiper theme · dropdown-disclosure dropdowns · dot-matrix loaders ·
   discrete-tabs · gooey quick-actions · adaptive-slider + frequency-selector in the
   audiobook player · time-undo on deletes · shuffle-pinned + carousel in Library ·
   flight-status/trade-summary repurposed as status/stats cards.
2. **Landing page (marketing):** device mockups · particle typography + text-repel
   hero · circuit-board · profile/feature/demo cards · carousel.

## Phased build

- **Phase A — Chrome (the shell).** Windows-11 **Mica** (`backgroundMaterial:'mica'`
  + zero-alpha `backgroundColor`, transparent renderer + **translucent sidebar**) à la
  Codex's "semi-transparent sidebar". KEEP the existing sidebar (no dock); it already
  flows into the title bar. Content surfaces stay opaque for readability.
- **Phase B — Core interactions.** dropdown-disclosure across all selects/filters;
  scroll-island wired to live curated status; discrete-tabs in Library; dot-matrix
  loaders replacing skeletons; gooey quick-actions; time-undo on deletes.
- **Phase C — Player & media.** adaptive-slider scrubber + frequency-selector speed
  in the audiobook player; carousel-navigator + shuffle-pinned in Library.
- **Phase D — Landing page.** New marketing route: device mockups, particle/text-repel
  hero, circuit-board, repurposed cards.

## Decisions (2026-06-29)

1. **No dock** — the cult-ui dock was accidental. Keep the existing **sidebar**
   (made translucent for Mica); it already flows into the title bar.
2. **No AI layer** — map components to existing UI only: dropdown-disclosure →
   search filters / sort / settings selects; scroll-island → live download/processing
   status. Contextual-ai-bar + model selector are dropped.
3. **Mica: yes** — adopt Codex-style translucent chrome (accepting the Electron
   frameless+maximize material bug).
4. **Landing page** — still planned (Phase D); confirm route vs standalone when we get there.

## Risks

- Mica + frameless **maximize** bug (Electron #41824/#42393) — material goes
  black / loses rounded corners; same bug Codex has on Windows.
- Several components are **domain-specific** (flight-status=travel, trade-summary=
  finance) — used decoratively/repurposed, not 1:1; flag any that don't earn a place.
- Dock-instead-of-sidebar is a **nav paradigm shift** + the bottom-edge conflict (Q1).
- Volume: ~20 components across two surfaces — strictly phased; each installed via CLI
  then adapted to San Citro's tokens/theme.

## Design language (inspiration: 60fps.design · designspells · seesaw.website · viewport-ui.design)

The component kit is the *vocabulary*; this is the *grammar* — how it should feel.

**Principles**
1. **Buttery motion (60fps).** Spring / deceleration easing — nothing "pops", everything flows; 200–300ms on state changes. **Stagger** list/grid entrances. **Shared-element** transitions (the mini-bar ↔ expanded player is the flagship one). No abrupt stops.
2. **Restraint + rhythm (seesaw / viewport-ui).** 8/16/24px spacing rhythm, 40%+ whitespace, 2–3 type weights, **one vivid accent on a neutral base** (San Citro is already neutral — pick a single signature accent). Premium = focus, not visual complexity.
3. **Delight in the details (designspells / 60fps).** Animated empty states (a friendly mascot/illustration), shimmer/gradient-pulse loaders, a small celebration on completion, satisfying toggles/checkboxes.
4. **Desktop premium (viewport-ui).** Persistent sidebar/panels (done), card systems, contextual toolbars on selection, a status panel, accent-on-neutral.

**Per-surface application** (kit component → with this grammar)
- **Search** — focus animation on the input; results **stagger-in**; loading = dot-matrix / gradient-pulse shimmer; empty state = an animated illustration (not the static magnifier).
- **Library** — card **hover lift/morph** + cover **shimmer-on-load**; grid stagger; `carousel-navigator` for "recent"; the audiobook **Ready** badge gets a subtle pop.
- **Audiobook player** — **spring** scrubber (`adaptive-slider`), play/pause **icon morph**, chapter list slide/stagger, and mini→expanded as a **shared-element crossfade** (we already animate bounds — add a content crossfade).
- **Downloads** — progress **pulse** + a **micro-celebration** (check/confetti) on complete (designspells "Vercel deploy" energy).
- **Dropdowns/selects** — `dropdown-disclosure` smooth disclosure; **dot-matrix** loaders everywhere.
- **Chrome** — Mica + rounded sidebar (done).
- **Landing** — particle/text-repel typography + device mockups + scroll-driven reveals.

## Surface designs (locked — grill 2026-06-29)

- **Type:** Geist (SF-adjacent) + Apple type metrics (tracking, weight/size hierarchy). No bundled SF Pro.
- **Page header:** **minimal — no large title**; the sidebar is the location cue; pages open straight into the glass toolbar + content.
- **Library:** **grid-first**, covers as the hero (rounded, soft shadow, title+author below); hover = lift + a contextual play/open glyph; citrus selection ring; **segmented Books/Audiobooks** (≈ Apple Books); list view secondary.
- **Status island:** a **title-bar-center "Dynamic Island"** — idle glass pill, expands downward on activity (download progress, "Processing… → Ready"), then settles. Backed by `scroll-island`.
- **Item interaction:** click a cover → a glass **detail sheet** (the cover does a shared-element **morph** in); big cover, metadata, description, actions (Read / Play / Reveal / Delete). Read → reader, Play → player. Secondary actions also via a native **right-click** menu.
- **Detail enrichment:** open instantly with known metadata; **lazily** fetch description + genre from **Google Books / OpenLibrary** (cached per book, graceful fallback).
- **Player (expanded, in-page):** **centered cover-hero**; scrubber / transport / speed below; a **Chapters** button slides in a glass chapter sheet.
- **Search:** **distinct** from the Library — task-oriented **rows** (cover thumb + title/author/year/format/size/lang) with an **inline Download**; not the grid+sheet. (Search = find fast; Library = browse your collection.)
- **Navigation / IA:** sidebar = **Search · Library · Activity · Settings**. Downloads + History **merge into "Activity"** (the full transfer log — completed/failed/processing); the title-bar **Dynamic Island** owns live status.
