"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  XIcon,
  BookOpenIcon,
} from "lucide-react";

import {
  onLoad,
  onSetMode,
  requestMode,
  saveProgress,
} from "@/lib/player-bridge";
import type { Chapter, PlayerLoadPayload, PlayerMode } from "@/types";

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/** Format seconds as M:SS or H:MM:SS. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const SAVE_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PlayerPage() {
  const audioRef = useRef<HTMLAudioElement>(null);

  const [payload, setPayload] = useState<PlayerLoadPayload | null>(null);
  const [mode, setMode] = useState<PlayerMode>("mini");
  const [chapterIndex, setChapterIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [coverFailed, setCoverFailed] = useState(false);

  const md5 = payload?.md5 ?? null;
  const chapters: Chapter[] = payload?.detail.chapters ?? [];
  const audiobook = payload?.detail.audiobook ?? null;
  const currentChapter = chapters[chapterIndex] ?? null;

  // The position to seek to once the *current* chapter's media is loaded. Set
  // when (re)loading a chapter so onLoadedMetadata can apply it.
  const seekToRef = useRef(0);
  const lastSavedRef = useRef(0);

  // ---- Load (from main) ---------------------------------------------------
  useEffect(() => {
    return onLoad((p) => {
      setPayload(p);
      setCoverFailed(false);
      // Resume from saved progress when available, else chapter 0 @ 0.
      const startIdx = p.progress
        ? Math.max(
            0,
            p.detail.chapters.findIndex(
              (c) => c.chapter_id === p.progress!.chapter_id
            )
          )
        : 0;
      setChapterIndex(startIdx);
      seekToRef.current = p.progress?.file_position_seconds ?? 0;
      lastSavedRef.current = 0;
    });
  }, []);

  // ---- Mode (from main) ---------------------------------------------------
  useEffect(() => {
    return onSetMode((m) => setMode(m));
  }, []);

  // ---- Load media when the chapter changes --------------------------------
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentChapter) return;
    setCurrentTime(0);
    setDuration(0);
    // Setting src + load() triggers onLoadedMetadata, which applies seekToRef.
    audio.load();
    void audio.play().catch(() => {
      // Autoplay may be blocked until first user gesture — reflect paused state.
      setIsPlaying(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md5, currentChapter?.chapter_id]);

  // ---- Progress persistence ----------------------------------------------
  const persist = useCallback(
    (positionSeconds: number) => {
      if (!md5 || !currentChapter) return;
      void saveProgress({
        md5,
        chapter_id: currentChapter.chapter_id,
        file_position_seconds: Math.floor(positionSeconds),
      }).catch(() => {});
    },
    [md5, currentChapter]
  );

  // Flush the latest position when the view is being hidden/torn down. Uses
  // pagehide + visibilitychange (NOT React unmount — the view persists across
  // main-window reloads, so unmount never fires here).
  useEffect(() => {
    const flush = () => {
      const audio = audioRef.current;
      if (audio) persist(audio.currentTime);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [persist]);

  // ---- Transport ----------------------------------------------------------
  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }, []);

  const goToChapter = useCallback(
    (index: number, atSeconds = 0) => {
      if (index < 0 || index >= chapters.length) return;
      seekToRef.current = atSeconds;
      lastSavedRef.current = 0;
      setChapterIndex(index);
    },
    [chapters.length]
  );

  const prevChapter = useCallback(() => {
    if (chapterIndex > 0) goToChapter(chapterIndex - 1);
  }, [chapterIndex, goToChapter]);

  const nextChapter = useCallback(() => {
    if (chapterIndex < chapters.length - 1) goToChapter(chapterIndex + 1);
  }, [chapterIndex, chapters.length, goToChapter]);

  const onScrub = useCallback((value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }, []);

  // ---- <audio> event handlers --------------------------------------------
  const handleLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setDuration(audio.duration || 0);
    if (seekToRef.current > 0) {
      audio.currentTime = Math.min(seekToRef.current, audio.duration || seekToRef.current);
      seekToRef.current = 0;
    }
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    // Throttle persistence to ~once per SAVE_INTERVAL_MS.
    const now = Date.now();
    if (now - lastSavedRef.current >= SAVE_INTERVAL_MS) {
      lastSavedRef.current = now;
      persist(audio.currentTime);
    }
  }, [persist]);

  const handleEnded = useCallback(() => {
    persist(duration);
    if (chapterIndex < chapters.length - 1) {
      goToChapter(chapterIndex + 1);
    } else {
      setIsPlaying(false);
    }
  }, [persist, duration, chapterIndex, chapters.length, goToChapter]);

  // ---- Render -------------------------------------------------------------
  if (!payload || !currentChapter || !md5) {
    // Nothing loaded yet (the view is built lazily and PLAYER_LOAD follows).
    // Transparent so nothing flashes before the first PLAYER_LOAD.
    return <div className="h-full w-full" />;
  }

  const title = audiobook?.title || "Untitled";
  const coverUrl = audiobook?.cover_url ?? null;
  const chapterLabel =
    currentChapter.title || `Chapter ${currentChapter.chapter_index + 1}`;

  const sharedAudio = (
    <audio
      ref={audioRef}
      src={`san-citro-media://${md5}/${currentChapter.chapter_id}`}
      onLoadedMetadata={handleLoadedMetadata}
      onTimeUpdate={handleTimeUpdate}
      onEnded={handleEnded}
      onPlay={() => setIsPlaying(true)}
      onPause={() => setIsPlaying(false)}
      preload="metadata"
    />
  );

  const cover = (sizeClass: string, iconClass: string) =>
    !coverUrl || coverFailed ? (
      <div className={`${sizeClass} bg-muted flex items-center justify-center rounded-md shrink-0`}>
        <BookOpenIcon className={`${iconClass} text-muted-foreground/40`} />
      </div>
    ) : (
      <div
        className={`${sizeClass} bg-muted overflow-hidden rounded-md shrink-0 shadow-lg ring-1 ring-black/10`}
      >
        <img
          src={coverUrl}
          alt={`Cover of ${title}`}
          className="h-full w-full object-cover"
          onError={() => setCoverFailed(true)}
        />
      </div>
    );

  if (mode === "expanded") {
    return (
      <div className="relative isolate flex h-full w-full flex-col overflow-hidden text-foreground">
        {/* Frosted backdrop: blurred cover art under a translucent scrim. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          {coverUrl && !coverFailed && (
            <img
              src={coverUrl}
              alt=""
              className="h-full w-full scale-125 object-cover blur-3xl"
            />
          )}
          <div className="absolute inset-0 bg-background/75 backdrop-blur-2xl" />
        </div>
        {sharedAudio}
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-2">
          <span className="truncate text-sm font-semibold" title={title}>
            {title}
          </span>
          <div className="flex items-center gap-1">
            <IconButton label="Collapse" onClick={() => requestMode("mini")}>
              <ChevronDownIcon className="size-4" />
            </IconButton>
            <IconButton label="Close player" onClick={() => requestMode("hidden")}>
              <XIcon className="size-4" />
            </IconButton>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {/* Chapter list */}
          <nav
            aria-label="Chapters"
            className="min-h-0 overflow-y-auto border-r border-border/40 p-2"
          >
            {chapters.map((c, i) => {
              const active = i === chapterIndex;
              return (
                <button
                  key={c.chapter_id}
                  type="button"
                  onClick={() => goToChapter(i)}
                  aria-current={active ? "true" : undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition ${
                    active
                      ? "bg-primary/15 font-medium text-primary shadow-sm backdrop-blur-sm"
                      : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
                  }`}
                >
                  <span className="w-6 shrink-0 text-right tabular-nums text-xs opacity-60">
                    {i + 1}
                  </span>
                  <span className="truncate">
                    {c.title || `Chapter ${c.chapter_index + 1}`}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Now playing */}
          <div className="flex min-h-0 flex-col items-center justify-center gap-6 p-8">
            {cover("aspect-square w-56 max-w-[40vh]", "size-16")}
            <div className="text-center">
              <div className="text-lg font-semibold leading-snug">{title}</div>
              <div className="mt-1 text-sm text-muted-foreground">{chapterLabel}</div>
            </div>

            <div className="w-full max-w-md">
              <Scrubber
                value={currentTime}
                max={duration}
                onChange={onScrub}
              />
              <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <IconButton
                label="Previous chapter"
                onClick={prevChapter}
                disabled={chapterIndex === 0}
              >
                <SkipBackIcon className="size-5" />
              </IconButton>
              <button
                type="button"
                onClick={togglePlay}
                aria-label={isPlaying ? "Pause" : "Play"}
                className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {isPlaying ? <PauseIcon className="size-6" /> : <PlayIcon className="size-6" />}
              </button>
              <IconButton
                label="Next chapter"
                onClick={nextChapter}
                disabled={chapterIndex >= chapters.length - 1}
              >
                <SkipForwardIcon className="size-5" />
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // mini
  return (
    <div className="relative isolate flex h-full w-full items-center gap-3 px-3 text-foreground">
      {/* Frosted bar backdrop (translucent over the body). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 border-t border-border/40 bg-background/80 backdrop-blur-xl"
      />
      {sharedAudio}
      {cover("size-12", "size-5")}

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight" title={title}>
          {title}
        </div>
        <div className="truncate text-xs text-muted-foreground">{chapterLabel}</div>
        <div className="mt-1 flex items-center gap-2">
          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
            {formatTime(currentTime)}
          </span>
          <Scrubber value={currentTime} max={duration} onChange={onScrub} compact />
          <span className="w-9 shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton label="Previous chapter" onClick={prevChapter} disabled={chapterIndex === 0}>
          <SkipBackIcon className="size-4" />
        </IconButton>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {isPlaying ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </button>
        <IconButton
          label="Next chapter"
          onClick={nextChapter}
          disabled={chapterIndex >= chapters.length - 1}
        >
          <SkipForwardIcon className="size-4" />
        </IconButton>
        <IconButton label="Expand player" onClick={() => requestMode("expanded")}>
          <ChevronUpIcon className="size-4" />
        </IconButton>
        <IconButton label="Close player" onClick={() => requestMode("hidden")}>
          <XIcon className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Scrubber({
  value,
  max,
  onChange,
  compact,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  compact?: boolean;
}) {
  return (
    <input
      type="range"
      min={0}
      max={max || 0}
      step={1}
      value={Math.min(value, max || 0)}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label="Seek"
      disabled={!max}
      className={`w-full cursor-pointer accent-primary ${compact ? "h-1" : "h-1.5"}`}
    />
  );
}
