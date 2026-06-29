# The renderer becomes a hash-routed SPA; the player moves in-page

San Citro pivots from MPA (per-route static HTML, full-reload `<a href>` navigation) to a
**single-page app**, to achieve the Apple-seamless navigation of [ADR-0011](0011-apple-liquid-glass-design-direction.md).
This **supersedes the premise of [ADR-0010](0010-persistent-player-webcontentsview-overlay.md)** —
that player exists *only* because full reloads destroyed an in-page `<audio>`.

**Decisions:**

- **SPA.** One shell mounts a client router; today's per-route pages (search, library, downloads,
  history, settings, reader, player) become **route components**. No full reloads.
- **Router: React Router `HashRouter`.** Corrected rationale (research 2026-06-29): Next 16's App
  Router *does* do client-side SPA navigation, and `output: export` "behaves like a traditional SPA"
  ([Next SPA guide](https://nextjs.org/docs/app/guides/single-page-applications)). What actually broke
  was never the router — it was **reload-resolution under a file protocol**: our handler maps
  `san-citro://app/<file>` → `renderer/<file>` with *no fallback*, so a client-routed extensionless
  URL (`…/library`) finds no file on reload/respawn. HashRouter's strength is **structural**: the `#`
  fragment is **never sent to the protocol handler**, so every reload resolves to one `index.html`,
  the SPA boots, and the hash selects the route — zero per-route resolution, zero RSC-fetch-under-
  custom-origin fragility, zero server. The cost (leaving Next's own router behind) is near-free in
  Electron: no URL bar, no SEO, no network prefetch to lose.
- **Keep `san-citro://` + Next as the bundler.** No local HTTP server — preserves the protocol's
  zero-network-surface security (this app deliberately deleted its HTTP `api/`), which matters for
  a downloads app. Next stays for building (Tailwind, fonts, components); only its *routing* is replaced.
- **Player in-page.** The audiobook player becomes a persistent React component in the shell,
  **reusing** the player UI + `san-citro-media://` protocol + audio/progress logic; the
  `WebContentsView`, its second preload, and the bounds/content-rect IPC are **deleted**.

## Considered options

- **Keep MPA + cross-document View Transitions** — rejected: user wants true SPA seamlessness (prefetch, zero reload).
- **History (`BrowserRouter`) + protocol SPA fallback** — rejected: risks the history/protocol friction that broke before.
- **Local `127.0.0.1` server + BrowserRouter** — rejected: opens a network surface + reverses the
  deliberate no-HTTP architecture, in exchange for a pretty URL that is *invisible* in Electron.
- **MemoryRouter** — rejected: loses the route on reload/respawn.
- **Vite + React Router migration** — rejected: large rework for no extra benefit here.

## Consequences

- **Supersedes ADR-0010.** The player is in-page; the WebContentsView is removed.
- Real **shared-element transitions** become possible (framer-motion layout / `AnimatePresence`
  across routes): cover→detail morphs, and the mini→expanded player as a true morph — a flagship
  Apple moment that the MPA model could not do.
- The `san-citro://` handler serves the **SPA shell**; route resolution is client-side (hash).
- Persistent chrome (sidebar, glass toolbar, player, status island) lives in the shell, rendered once.
- **Risk:** a real re-architecture of the just-shipped (v1.2.0) renderer — sequence carefully,
  re-verify in-app, and keep v1.2.0 as the rollback point.
- **Phase 1 is a throwaway spike** (verify, don't assert): a 2-route SPA under `san-citro://` that
  survives reload *and* single-instance respawn, before any real UI is built on it. If HashRouter
  doesn't hold under the protocol, we learn it in an afternoon, not after porting every page.
- The protocol handler must move off **`registerFileProtocol`** (deprecated → `protocol.handle`).
  This work touches the handler regardless, so the migration is folded in, not extra.
