"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  XIcon,
} from "lucide-react";

import { usePlayer } from "@/contexts/player-context";
import { RemoteCoverImage } from "@/components/remote-cover-image";
import { mediaUrlForChapter } from "@/lib/playback-policy";
import type { Chapter } from "@/types";

// The persistent audiobook player, in-page (ADR-0013). The <audio> lives in the
// shell — outside <Routes> — so playback survives route changes. Transport
// policy (chapter index, resume, save cadence, next-on-end) lives in
// PlaybackPolicy via PlayerContext; this component is chrome + audio wiring.
// NOTE (glass-killer trap): must NOT be wrapped in any Motion layout-animated
// ancestor, or its backdrop-filter will silently blank.

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

/** Cover keyed by md5 so error state resets without a setState-in-effect. */
function PlayerCover({
  md5,
  coverUrl,
  title,
  sizeClass,
  iconClass,
}: {
  md5: string;
  coverUrl: string | null;
  title: string;
  sizeClass: string;
  iconClass: string;
}) {
  return (
    <RemoteCoverImage
      key={md5}
      src={coverUrl}
      alt={`Cover of ${title}`}
      className={`${sizeClass} rounded-md shrink-0 shadow-lg ring-1 ring-black/10`}
      fallbackIconClassName={iconClass}
      loading="eager"
    />
  );
}

export function InPagePlayer() {
  const {
    payload,
    mode,
    setMode,
    close,
    policy,
    bindAudio,
    session,
  } = usePlayer();

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const md5 = payload?.md5 ?? null;
  const chapters: Chapter[] = payload?.detail.chapters ?? [];
  const audiobook = payload?.detail.audiobook ?? null;
  const chapterIndex = session.chapterIndex;
  const currentChapter = chapters[chapterIndex] ?? null;
  const isPlaying = session.isPlaying;
  const currentTime = session.currentTime;
  const duration = session.duration;

  // Bind AudioPort to the element for the shared policy instance.
  const setAudioNode = useCallback(
    (el: HTMLAudioElement | null) => {
      audioRef.current = el;
      bindAudio(el);
    },
    [bindAudio]
  );

  // ---- Load media when the chapter (or book) changes ----------------------
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentChapter || !md5) return;
    audio.load();
    void audio.play().catch(() => {
      policy.onPause();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md5, currentChapter?.chapter_id]);

  // Flush the latest position when the window is closing. In-page the <audio>
  // is part of the React tree, so beforeunload (Electron window close) +
  // cleanup cover teardown.
  useEffect(() => {
    const flush = () => {
      policy.flush();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      flush();
      window.removeEventListener("beforeunload", flush);
    };
  }, [policy]);

  // ---- Transport (delegates to policy) ------------------------------------
  const togglePlay = useCallback(() => {
    policy.togglePlay();
  }, [policy]);

  const goToChapter = useCallback(
    (index: number, atSeconds = 0) => {
      policy.goToChapter(index, atSeconds);
    },
    [policy]
  );

  const prevChapter = useCallback(() => {
    policy.prevChapter();
  }, [policy]);

  const nextChapter = useCallback(() => {
    policy.nextChapter();
  }, [policy]);

  const onScrub = useCallback(
    (value: number) => {
      policy.seek(value);
    },
    [policy]
  );

  // ---- <audio> event handlers → policy ------------------------------------
  const handleLoadedMetadata = useCallback(() => {
    policy.onLoadedMetadata();
  }, [policy]);

  const handleTimeUpdate = useCallback(() => {
    policy.onTimeUpdate();
  }, [policy]);

  const handleEnded = useCallback(() => {
    policy.onEnded();
  }, [policy]);

  // ---- Render -------------------------------------------------------------
  if (!payload || mode === "hidden" || !currentChapter || !md5) return null;

  const title = audiobook?.title || "Untitled";
  const coverUrl = audiobook?.cover_url ?? null;
  const chapterLabel =
    currentChapter.title || `Chapter ${currentChapter.chapter_index + 1}`;
  const src = mediaUrlForChapter(md5, currentChapter.chapter_id);

  const cover = (sizeClass: string, iconClass: string) => (
    <PlayerCover
      md5={md5}
      coverUrl={coverUrl}
      title={title}
      sizeClass={sizeClass}
      iconClass={iconClass}
    />
  );

  // Single <audio> outside mini/expanded chrome so mode toggles cannot remount
  // the media element (ticket #28). Only chrome differs between modes.
  const audioEl = (
    <audio
      ref={setAudioNode}
      src={src}
      onLoadedMetadata={handleLoadedMetadata}
      onTimeUpdate={handleTimeUpdate}
      onEnded={handleEnded}
      onPlay={() => policy.onPlay()}
      onPause={() => policy.onPause()}
      preload="metadata"
    />
  );

  const expandedChrome = (
    // In-page: a fixed overlay over the content column, below the 36px title bar.
    <div className="absolute inset-x-0 bottom-0 top-9 z-40 isolate flex flex-col overflow-hidden text-foreground">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        {coverUrl ? (
          <RemoteCoverImage
            key={`${md5}-blur`}
            src={coverUrl}
            alt=""
            decorative
            className="h-full w-full"
            imgClassName="h-full w-full scale-125 object-cover blur-3xl"
            loading="eager"
          />
        ) : null}
        <div className="absolute inset-0 bg-background/75 backdrop-blur-2xl" />
      </div>
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2">
        <span className="truncate text-sm font-semibold" title={title}>{title}</span>
        <div className="flex items-center gap-1">
          <IconButton label="Collapse" onClick={() => setMode("mini")}>
            <ChevronDownIcon className="size-4" />
          </IconButton>
          <IconButton label="Close player" onClick={close}>
            <XIcon className="size-4" />
          </IconButton>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <nav aria-label="Chapters" className="min-h-0 overflow-y-auto border-r border-border/40 p-2">
          {chapters.map((c, i) => {
            const activeCh = i === chapterIndex;
            return (
              <button
                key={c.chapter_id}
                type="button"
                onClick={() => goToChapter(i)}
                aria-current={activeCh ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition ${
                  activeCh
                    ? "bg-primary/15 font-medium text-primary shadow-sm backdrop-blur-sm"
                    : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
                }`}
              >
                <span className="w-6 shrink-0 text-right tabular-nums text-xs opacity-60">{i + 1}</span>
                <span className="truncate">{c.title || `Chapter ${c.chapter_index + 1}`}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex min-h-0 flex-col items-center justify-center gap-6 p-8">
          {cover("aspect-square w-56 max-w-[40vh]", "size-16")}
          <div className="text-center">
            <div className="text-lg font-semibold leading-snug">{title}</div>
            <div className="mt-1 text-sm text-muted-foreground">{chapterLabel}</div>
          </div>
          <div className="w-full max-w-md">
            <Scrubber value={currentTime} max={duration} onChange={onScrub} />
            <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <IconButton label="Previous chapter" onClick={prevChapter} disabled={chapterIndex === 0}>
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
            <IconButton label="Next chapter" onClick={nextChapter} disabled={chapterIndex >= chapters.length - 1}>
              <SkipForwardIcon className="size-5" />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );

  // mini — a fixed bottom bar over the content column.
  const miniChrome = (
    <div className="absolute inset-x-0 bottom-0 z-30 flex h-[72px] items-center gap-3 px-3 text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 border-t border-border/40 bg-background/80 backdrop-blur-xl"
      />
      {cover("size-12", "size-5")}

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight" title={title}>{title}</div>
        <div className="truncate text-xs text-muted-foreground">{chapterLabel}</div>
        <div className="mt-1 flex items-center gap-2">
          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{formatTime(currentTime)}</span>
          <Scrubber value={currentTime} max={duration} onChange={onScrub} compact />
          <span className="w-9 shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatTime(duration)}</span>
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
        <IconButton label="Next chapter" onClick={nextChapter} disabled={chapterIndex >= chapters.length - 1}>
          <SkipForwardIcon className="size-4" />
        </IconButton>
        <IconButton label="Expand player" onClick={() => setMode("expanded")}>
          <ChevronUpIcon className="size-4" />
        </IconButton>
        <IconButton label="Close player" onClick={close}>
          <XIcon className="size-4" />
        </IconButton>
      </div>
    </div>
  );

  return (
    <>
      {audioEl}
      {mode === "expanded" ? expandedChrome : miniChrome}
    </>
  );
}

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
