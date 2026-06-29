# The reader engine is foliate-js (multi-format), replacing epub.js

The in-app reader moves from **epub.js** (EPUB-only, near-dormant) to **foliate-js** (the Foliate
app's rendering engine), so it can open the formats Anna's Archive actually delivers — not just EPUB.
Today MOBI / AZW3 / CBZ comics / PDF are download-only and unreadable in-app; this closes that gap.

**Decision:**

- **Engine: foliate-js.** Reads **EPUB, MOBI, AZW3/KF8, FB2, CBZ (comics)**; **PDF is experimental**
  (needs PDF.js) and **deferred** to a later pass. Supports paginated + scrolled, MIT, native ES modules.
- **Stability via vendoring + pinning.** foliate-js has **no npm release** and warns "API may change at
  any time." Mitigation: **vendor a pinned copy** (its ES modules at a fixed commit, into the renderer) —
  pinned, its instability cannot break us; we choose when to update. This is the price of its capability.
- **Thin React wrapper.** Replace the epub.js `rendition` wrapper in `reader/page.tsx` with a small React
  wrapper over foliate-js's paginator/`<foliate-view>`. Reuse the existing `readBookFile → ArrayBuffer`
  flow and the `san-citro:` + `blob:` CSP (foliate-js also renders into blob iframes — no CSP change).
- **Two render modes by format.** **Reflowable** (epub/mobi/azw3/fb2) gets the Apple-Books treatment —
  paginated, light/sepia/dark themes, type controls, auto-hiding glass chrome. **Fixed/image** (CBZ,
  later PDF) gets a **page-image view** — page nav + zoom, no type controls. The reader detects the
  format and picks the mode.

## Considered options

- **Keep epub.js** — rejected: EPUB-only, so AA's mobi/azw3/comics/pdf stay unreadable in-app; also
  near-unmaintained (~12 commits, 1 contributor, no tests).
- **Readium (Web)** — rejected: EPUB-only too, its web reflow navigator is still in development
  (Q4 2025), and integration is heavy — wrong tool for web right now despite being standards-grade.

## Consequences

- The reader becomes **multi-format**; the **"Read" action** (Library card + detail sheet) now applies
  to every supported format, not just EPUB — the readable-format gate must widen accordingly.
- The reader page is **rewritten** (not just restyled) during Phase 4+ — scope grew from polish to a
  renderer swap. Sequence it like any other surface; epub.js stays until foliate-js reaches parity.
- foliate-js is **vendored + pinned** in the repo (no npm dependency); document the pinned commit.
- **PDF deferred** — ship epub/mobi/azw3/fb2/cbz first; add PDF (PDF.js) only if wanted, marked experimental.
- Supersedes the implicit epub.js choice; updates the [revamp reader surface](../plans/frontend-revamp.md).
