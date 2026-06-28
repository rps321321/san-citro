# The audiobook player is a persistent WebContentsView overlay

The app is a static-export, **full-page-reload multi-page** renderer (nav is plain `<a href>`,
zero `next/link`, `output: "export"`; navigation reloads the whole window) — so a playing
`<audio>` in a normal page is destroyed on every navigation, making an in-page persistent
"browse while listening" player impossible.

**Decision:** the player is a child **`WebContentsView`** attached to `mainWindow.contentView`
(verified in the installed Electron 35 types: `WebContentsView`, `contentView.addChildView`,
`setBounds`). It has its **own webContents that never reloads**, owns the `<audio>` and *all*
player UI — a **bottom mini-bar** that `setBounds`-expands to a full player. The main browsing
window keeps reloading as the user navigates; the view keeps playing. The Library triggers and
observes it over IPC ("play md5/chapter", state events); audio streams via `san-citro-media://`.

## Considered options

- **Full-page `/player` page (rejected for v1 goal):** simplest, but navigating away stops
  playback — no browse-while-listening, which was the whole point of the mini-bar.
- **Separate top-level BrowserWindow (rejected):** survives reloads too, but it's a detached
  floating window, not an integrated overlay in the main window.
- **Convert the app to SPA routing (rejected):** would let an in-page player persist, but the
  team deliberately avoided client-side routing because `next/navigation` is unreliable under
  the `san-citro://` protocol — the riskiest path.

## Consequences

- A `player.html` loaded into the view + an IPC playback-control/state channel; the main layout
  reserves bottom space (or the bar floats) while a player is active.
- The view shares the `san-citro-media://` scheme + `media-src` CSP from the media-protocol plan.
- Player UI lives entirely in the view, so main pages stay player-UI-free (they only trigger/observe).
