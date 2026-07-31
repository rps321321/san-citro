# Visual language is a warm, precise Windows desktop library utility

San Citro’s product UI is a **warm, precise Windows desktop library utility** — Fluent-adjacent
proportions, Windows interaction conventions, restrained citrus branding. It is **not** a Mac app
imitation, not Apple “Liquid Glass” cosplay, and not a maximalist component-kit demo.

This record **supersedes** the Apple-as-north-star / Liquid Glass framing of
[ADR-0011](0011-apple-liquid-glass-design-direction.md). Material mechanics that still hold
(shell translucency vs opaque content, single citrus accent, light/dark) are restated here in
Windows product language. Later surface tickets consume this system; this ADR does **not** redesign
every page.

**Decisions:**

- **Direction.** Warm precise Windows desktop library utility. Prefer clarity, density appropriate
  to a personal archive tool, and controls that read as product chrome — not decorative motion or
  platform cosplay.
- **Relationship to ADR-0011.** Apple philosophy / Liquid Glass / Dynamic Island naming as the
  aesthetic north star is **retired**. Retained: (1) **citrus** as the sole brand accent;
  (2) **translucent shell chrome** vs **opaque content**; (3) light and dark themes; (4) blur budget
  and the containing-block trap for `backdrop-filter` (no blur inside Motion-transformed ancestors).
- **Shell translucency.** Mica (window) + CSS glass (`.glass` / `.sidebar-glass`) only on **shell
  chrome**: sidebar rail, title-bar status pill, floating overlays (command palette, popovers where
  already glass). Do **not** glass tables, Settings forms, Reader pages, result rows, or primary
  content cards.
- **Opaque content.** The main content column (`SidebarInset` / `#main-content`), tables, Settings,
  Reader, and library/search surfaces use solid backgrounds (`.surface-content` / `bg-background`)
  for legibility.
- **Semantic citrus.** Citrus (`--primary` / `--ring`) is reserved for **primary actions**, **active
  navigation**, **progress/status emphasis**, and **focus rings** — not decorative fills or every
  hover. Neutrals and borders carry structure.
- **Typography roles** (shared scale; later tickets apply consistently):
  - **page-title** — route-level heading
  - **section-title** — card/section heading
  - **body** — default UI copy
  - **meta** — secondary labels, timestamps, helper text
  - **mono** — MD5, paths, versions, tabular ids
- **Spacing.** 4px base scale (`--space-1` …); page padding stays `p-4` / `md:p-6` unless a surface
  ticket changes it.
- **Radii.** Existing `--radius` ladder (sm→4xl). Shell chrome stays flush to the window edge (no
  floating large outer radius on the default sidebar rail — DWM owns outer rounding).
- **Borders & elevation.** Hairline semantic borders (`--border`); elevation steps 0–3 for floating
  chrome only (status, palette, sheets) — content surfaces stay flat.
- **Focus.** Visible citrus focus rings (`--ring`); never remove focus styles for aesthetics.
- **Motion.** Product-purpose only (state change, enter/exit of meaningful UI). Springs/eases are
  desktop-utility presets, not “Apple motion.” Honor `prefers-reduced-motion` (global CSS + Motion
  `useReducedMotion` where animation is JS-driven).
- **Terminology.** Prefer **status pill** / **activity status** (not Dynamic Island);
  **shell glass** / **translucency** (not Liquid Glass); drop Apple-imitation component names in
  product code comments.
- **Decorative kit.** Remove or restyle non-product decoration (`TextRepel`, always-hidden hover
  arrows, unused maximalist demos) when it appears on the product shell. No wholesale component
  library rewrite in this change.

## Considered options

- **Keep Apple Liquid Glass as north star (ADR-0011 as written)** — rejected: the app is a Windows
  Electron utility; mixed Mac references produced an incoherent, under-intentional look.
- **Full Fluent/WinUI component rebuild** — rejected: out of scope; keep shadcn/base-ui stack and
  define a token/role system instead.
- **Glass on every surface** — rejected (unchanged from 0011): legibility and clutter.
- **Drop citrus for system accent** — rejected: brand identity stays citrus.

## Consequences

- Tokens and utility classes in `web/src/app/globals.css` are the contract later UX tickets consume.
- Shell-only glass + opaque content is enforceable in code review and sidebar chrome tests.
- ADR-0012’s “keep Apple-fitting kit parts” language is historically frozen; new work judges kit
  parts against **this** direction (Windows library utility), not Mac fidelity.
- Glossary in `CONTEXT.md` tracks shell chrome / content / citrus / status pill under this ADR.
