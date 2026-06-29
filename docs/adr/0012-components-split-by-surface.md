# Components are split by surface: refined app, expressive landing

Per [ADR-0011](0011-apple-liquid-glass-design-direction.md), the **app** is refined Apple-glass.
The previously-chosen component kit is reconciled by **surface** rather than discarded — the
parts that read as Apple stay in the app; the expressive parts move to the marketing landing page,
where "wow" is appropriate. Nothing is wasted, and the app never feels gimmicky.

**Decision:**

- **App (refined) — keep only Apple-fitting parts:** `scroll-island` (≈ Dynamic Island status),
  `discrete-tabs` (≈ macOS segmented control), `dropdown-disclosure` (selects/filters),
  `adaptive-slider` (player scrubber/volume), `frequency-selector` (playback speed),
  `skiper26` (theme toggle). Loaders use a **quiet Apple-style spinner/progress**, not dot-matrix.
- **Landing (expressive) — the kit's "wow" parts:** `cursor-particle-typography`, `circuit-board`,
  `text-repel`, device mockups, `gooey-menu`, `flight-status-card` / `trade-summary` / `profile-card`
  as demo widgets, `dotmatrix`.
- **The app never uses the expressive components.**

## Consequences

- `text-repel` comes **off the sidebar logo** — replaced by clean SF-adjacent type.
- Custom Apple-refined components fill the gaps the kit doesn't cover (the glass surface utility,
  macOS-style controls, the spinner).
- The goal's component table is re-scoped into an **app-kit** and a **landing-kit**.
- The landing page (goal Phase D) becomes the home for everything expressive.
