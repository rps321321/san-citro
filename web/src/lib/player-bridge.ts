// Typed accessor for window.player — the bridge the player-preload injects into
// the player WebContentsView. The player page (player/page.tsx) is the only
// consumer. Methods degrade to safe no-ops when the bridge is absent (e.g. during
// static export / when the page is opened outside the Electron view) so the page
// never crashes for a missing preload.

import type {
  AudiobookProgress,
  PlayerBridge,
  PlayerLoadPayload,
  PlayerMode,
} from "@/types";

function bridge(): PlayerBridge | undefined {
  return typeof window === "undefined" ? undefined : window.player;
}

/** Subscribe to the load event. Returns an unsubscribe function. */
export function onLoad(cb: (payload: PlayerLoadPayload) => void): () => void {
  return bridge()?.onLoad(cb) ?? (() => {});
}

/** Subscribe to mode changes pushed from main. Returns an unsubscribe function. */
export function onSetMode(cb: (mode: PlayerMode) => void): () => void {
  return bridge()?.onSetMode(cb) ?? (() => {});
}

/** Ask main to switch the view's display mode. */
export function requestMode(mode: PlayerMode): void {
  bridge()?.requestMode(mode);
}

/** Load saved progress for an audiobook. */
export function getProgress(md5: string): Promise<AudiobookProgress | null> {
  return bridge()?.getProgress(md5) ?? Promise.resolve(null);
}

/** Persist playback position. */
export function saveProgress(p: {
  md5: string;
  chapter_id: number;
  file_position_seconds: number;
}): Promise<void> {
  return bridge()?.saveProgress(p) ?? Promise.resolve();
}
