"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { PlayerLoadPayload, PlayerMode } from "@/types";
import { playAudiobook as playAudiobookIpc } from "@/lib/api-client";

// In-page player state (ADR-0013). Replaces the WebContentsView + its PLAYER_LOAD
// / PLAYER_SET_MODE IPC pushes: any route can call play(md5); the persistent
// <InPagePlayer> in the shell reads payload + mode from here. The <audio> lives in
// the shell (outside <Routes>), so it survives route changes — the parity
// guarantee the sibling WebContentsView used to provide.
interface PlayerContextValue {
  payload: PlayerLoadPayload | null;
  mode: PlayerMode;
  /** True while a book is loaded and the player is visible (mini/expanded). */
  active: boolean;
  /** Start (or switch to) playing an audiobook. */
  play: (md5: string) => Promise<void>;
  setMode: (mode: PlayerMode) => void;
  /** Close the player: stop showing it and drop the loaded book. */
  close: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within a PlayerProvider");
  return ctx;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<PlayerLoadPayload | null>(null);
  const [mode, setMode] = useState<PlayerMode>("hidden");

  const play = useCallback(async (md5: string) => {
    // The main process returns { md5, detail, progress } (no PLAYER_LOAD push).
    const p = await playAudiobookIpc(md5);
    setPayload(p);
    setMode("mini");
  }, []);

  const close = useCallback(() => {
    setMode("hidden");
    setPayload(null);
  }, []);

  const active = payload !== null && mode !== "hidden";

  return (
    <PlayerContext.Provider value={{ payload, mode, active, play, setMode, close }}>
      {children}
    </PlayerContext.Provider>
  );
}
