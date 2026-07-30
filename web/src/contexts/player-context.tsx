"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PlayerLoadPayload, PlayerMode } from "@/types";
import {
  playAudiobook as playAudiobookIpc,
  saveAudiobookProgress,
} from "@/lib/api-client";
import {
  createHtmlAudioPort,
  createPlaybackPolicy,
  type PlaybackPolicy,
  type PlaybackSnapshot,
} from "@/lib/playback-policy";

// In-page player state (ADR-0013). Owns Playback policy (chapter/resume/save/
// next-on-end) with AudioPort + ProgressStore adapters — not only a static
// payload bag. The <audio> lives in shell chrome (outside <Routes>); policy
// survives route changes with the SPA shell.

interface PlayerContextValue {
  payload: PlayerLoadPayload | null;
  mode: PlayerMode;
  /** True while a book is loaded and the player is visible (mini/expanded). */
  active: boolean;
  /** Start (or switch to) playing an audiobook. */
  play: (md5: string) => Promise<void>;
  setMode: (mode: PlayerMode) => void;
  /** Close the player: flush progress, hide chrome, drop session. */
  close: () => void;
  /** Testable playback controller (resume, cadence, next-on-end). */
  policy: PlaybackPolicy;
  /** Bind the in-page <audio> element to the policy's AudioPort. */
  bindAudio: (el: HTMLAudioElement | null) => void;
  /** Latest policy snapshot (chapter index, times, playing). */
  session: PlaybackSnapshot;
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
  const playRequestIdRef = useRef(0);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const policyRef = useRef<PlaybackPolicy | null>(null);
  if (!policyRef.current) {
    policyRef.current = createPlaybackPolicy({
      audio: createHtmlAudioPort(() => audioElRef.current),
      progress: {
        save: (p) => saveAudiobookProgress(p),
      },
    });
  }
  const policy = policyRef.current;

  const session = useSyncExternalStore(
    policy.subscribe,
    policy.getSnapshot,
    policy.getSnapshot
  );

  const bindAudio = useCallback((el: HTMLAudioElement | null) => {
    audioElRef.current = el;
  }, []);

  const play = useCallback(
    async (md5: string) => {
      // The main process returns { md5, detail, progress } (no PLAYER_LOAD push).
      const requestId = ++playRequestIdRef.current;
      const p = await playAudiobookIpc(md5);
      if (requestId !== playRequestIdRef.current) return;
      policy.loadSession({
        md5: p.md5,
        chapters: p.detail.chapters,
        progress: p.progress
          ? {
              chapter_id: p.progress.chapter_id,
              file_position_seconds: p.progress.file_position_seconds,
            }
          : null,
      });
      setPayload(p);
      setMode("mini");
    },
    [policy]
  );

  const close = useCallback(() => {
    playRequestIdRef.current += 1;
    policy.flush();
    policy.clearSession();
    setMode("hidden");
    setPayload(null);
  }, [policy]);

  const active = payload !== null && mode !== "hidden";

  const value = useMemo(
    () => ({
      payload,
      mode,
      active,
      play,
      setMode,
      close,
      policy,
      bindAudio,
      session,
    }),
    [payload, mode, active, play, setMode, close, policy, bindAudio, session]
  );

  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
}
