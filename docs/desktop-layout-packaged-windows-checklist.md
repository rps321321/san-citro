# Packaged Windows — native title-bar checklist (issue #64)

Automated layout regression covers renderer shell composition (title-bar strip,
overlay safe-area, Search controls, sidebar, Status Island) at **1360×920** and
**1120×840**. Native Windows caption-button **hover** states cannot be reliably
emulated with image snapshots; run this short checklist on a packaged build.

## Preconditions

- Packaged installer or `electron-app` release build on Windows 11 (or 10).
- Light and dark theme both available in Settings / sidebar theme control.
- Default window size (~1360×920) and resize down to the min floor (~1120×840).

## Native title-bar (Electron `titleBarOverlay`)

| # | Check | Light | Dark |
|---|--------|:-----:|:----:|
| 1 | Minimize / Maximize / Close are **OS-owned** (not recreated in React) | ☐ | ☐ |
| 2 | Caption glyphs remain readable on title-bar fill | ☐ | ☐ |
| 3 | Hover on Minimize / Maximize uses normal system chrome | ☐ | ☐ |
| 4 | Hover on **Close** shows Windows destructive (red) treatment | ☐ | ☐ |
| 5 | Theme switch updates overlay colors without a long wrong-color flash | ☐ | ☐ |
| 6 | Renderer content never paints under the caption-button strip | ☐ | ☐ |

## Shell chrome (smoke with packaging)

| # | Check | Pass |
|---|--------|:----:|
| 7 | Status Island (active download) remains clickable and clear of caption buttons | ☐ |
| 8 | Command palette control (title-bar) is clickable; does not sit under Close | ☐ |
| 9 | Sidebar expand/collapse does not clip the title-bar drag band | ☐ |
| 10 | Search at min window: query field + Search button remain usable (no clip) | ☐ |

## Out of scope for automation

- Pixel-perfect native Close hover color sampling
- Every route screenshot matrix
- Using visual snapshots as the sole accessibility test

## Related

- Renderer contract: `web/src/lib/titlebar.ts`, `web/src/components/app-header.tsx`
- Main process: `electron-app/src/main.ts` (`titleBarOverlay`, min/default sizes)
- Automated gates: `web/src/components/desktop-layout.regression.test.tsx`
