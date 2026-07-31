/**
 * Playback policy — chapter index, resume position, progress-save cadence,
 * and next-chapter-on-end for an audiobook session (CONTEXT: Playback policy;
 * ADR-0013 In-page player).
 *
 * Pure module (no React, no DOM): real seam is AudioPort + ProgressStore.
 * In-page player chrome binds production adapters; unit tests use fakes.
 */

/** Progress-save cadence while listening (ms). */
export const SAVE_INTERVAL_MS = 5000;

/** Minimal chapter identity needed for resume + advance. */
export interface PlaybackChapter {
  chapter_id: number;
}

/** Saved progress shape used for resume (subset of AudiobookProgress). */
export interface PlaybackProgress {
  chapter_id: number;
  file_position_seconds: number;
}

/**
 * Audio adapter — production wraps HTMLAudioElement; tests use an in-memory fake.
 * Policy does not own media URL construction or the element lifecycle.
 */
export interface AudioPort {
  play(): Promise<void>;
  pause(): void;
  getCurrentTime(): number;
  setCurrentTime(seconds: number): void;
  getDuration(): number;
  isPaused(): boolean;
}

/** Progress persistence adapter — production IPC; tests use memory. */
export interface ProgressStore {
  save(input: {
    md5: string;
    chapter_id: number;
    file_position_seconds: number;
  }): void | Promise<void>;
}

export interface PlaybackClock {
  now(): number;
}

export interface PlaybackSessionInput {
  md5: string;
  chapters: readonly PlaybackChapter[];
  progress: PlaybackProgress | null;
}

export interface PlaybackSnapshot {
  md5: string | null;
  chapters: readonly PlaybackChapter[];
  chapterIndex: number;
  /** True when a session is loaded and has at least one chapter. */
  active: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  /** Pending resume/seek applied on loadedmetadata (0 when none). */
  pendingSeekSeconds: number;
}

export type PlaybackListener = (snapshot: PlaybackSnapshot) => void;

export interface PlaybackPolicy {
  subscribe(listener: PlaybackListener): () => void;
  getSnapshot(): PlaybackSnapshot;
  /** Start or replace the audiobook session (resume when progress is set). */
  loadSession(input: PlaybackSessionInput): void;
  /** Drop the session (player close). */
  clearSession(): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  goToChapter(index: number, atSeconds?: number): void;
  prevChapter(): void;
  nextChapter(): void;
  seek(seconds: number): void;
  /** Apply pending seek after media metadata is ready. */
  onLoadedMetadata(): void;
  /** Drive UI time + save cadence. */
  onTimeUpdate(): void;
  onPlay(): void;
  onPause(): void;
  /** Persist and auto-advance (or stop) when a chapter ends. */
  onEnded(): void;
  /** Force-save current position (beforeunload / unmount). */
  flush(): void;
}

const defaultClock: PlaybackClock = {
  now: () => Date.now(),
};

/**
 * Resolve resume chapter index + file position from saved progress.
 * Unknown chapter_id falls back to chapter 0 at 0s.
 */
export function resolveResume(
  chapters: readonly PlaybackChapter[],
  progress: PlaybackProgress | null | undefined
): { chapterIndex: number; positionSeconds: number } {
  if (!progress || chapters.length === 0) {
    return { chapterIndex: 0, positionSeconds: 0 };
  }
  const idx = chapters.findIndex((c) => c.chapter_id === progress.chapter_id);
  if (idx < 0) {
    return { chapterIndex: 0, positionSeconds: 0 };
  }
  const positionSeconds = Math.max(0, Number(progress.file_position_seconds) || 0);
  return { chapterIndex: idx, positionSeconds };
}

/**
 * Next chapter index after `current`, or null when at the last chapter.
 */
export function nextChapterIndex(
  current: number,
  chapterCount: number
): number | null {
  if (chapterCount <= 0) return null;
  if (current < 0 || current >= chapterCount - 1) return null;
  return current + 1;
}

/**
 * Previous chapter index before `current`, or null when at the first.
 */
export function prevChapterIndex(current: number): number | null {
  if (current <= 0) return null;
  return current - 1;
}

export function createPlaybackPolicy(options: {
  audio: AudioPort;
  progress: ProgressStore;
  clock?: PlaybackClock;
  saveIntervalMs?: number;
}): PlaybackPolicy {
  const audio = options.audio;
  const progressStore = options.progress;
  const clock = options.clock ?? defaultClock;
  const saveIntervalMs = options.saveIntervalMs ?? SAVE_INTERVAL_MS;

  let md5: string | null = null;
  let chapters: readonly PlaybackChapter[] = [];
  let chapterIndex = 0;
  let isPlaying = false;
  let currentTime = 0;
  let duration = 0;
  let pendingSeekSeconds = 0;
  let lastSavedAt = 0;

  const listeners = new Set<PlaybackListener>();
  let cachedSnapshot: PlaybackSnapshot = emptySnapshot();

  function emptySnapshot(): PlaybackSnapshot {
    return {
      md5: null,
      chapters: [],
      chapterIndex: 0,
      active: false,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      pendingSeekSeconds: 0,
    };
  }

  function rebuildSnapshot(): PlaybackSnapshot {
    cachedSnapshot = {
      md5,
      chapters,
      chapterIndex,
      active: md5 !== null && chapters.length > 0,
      isPlaying,
      currentTime,
      duration,
      pendingSeekSeconds,
    };
    return cachedSnapshot;
  }

  function emit(): void {
    const snap = rebuildSnapshot();
    for (const listener of listeners) {
      listener(snap);
    }
  }

  function currentChapter(): PlaybackChapter | null {
    if (!md5 || chapters.length === 0) return null;
    return chapters[chapterIndex] ?? null;
  }

  function persist(positionSeconds: number): void {
    const chapter = currentChapter();
    if (!md5 || !chapter) return;
    const seconds = Math.floor(Math.max(0, positionSeconds));
    void Promise.resolve(
      progressStore.save({
        md5,
        chapter_id: chapter.chapter_id,
        file_position_seconds: seconds,
      })
    ).catch(() => {});
  }

  function goToChapter(index: number, atSeconds = 0): void {
    if (index < 0 || index >= chapters.length) return;
    chapterIndex = index;
    pendingSeekSeconds = Math.max(0, atSeconds);
    currentTime = 0;
    duration = 0;
    lastSavedAt = 0;
    emit();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return cachedSnapshot;
    },

    loadSession(input) {
      md5 = input.md5;
      chapters = input.chapters.slice();
      const resume = resolveResume(chapters, input.progress);
      chapterIndex = resume.chapterIndex;
      pendingSeekSeconds = resume.positionSeconds;
      currentTime = 0;
      duration = 0;
      isPlaying = false;
      lastSavedAt = 0;
      emit();
    },

    clearSession() {
      md5 = null;
      chapters = [];
      chapterIndex = 0;
      pendingSeekSeconds = 0;
      currentTime = 0;
      duration = 0;
      isPlaying = false;
      lastSavedAt = 0;
      emit();
    },

    play() {
      if (!currentChapter()) return;
      void audio.play().catch(() => {
        isPlaying = false;
        emit();
      });
    },

    pause() {
      audio.pause();
    },

    togglePlay() {
      if (!currentChapter()) return;
      if (audio.isPaused()) {
        void audio.play().catch(() => {
          isPlaying = false;
          emit();
        });
      } else {
        audio.pause();
      }
    },

    goToChapter,

    prevChapter() {
      const prev = prevChapterIndex(chapterIndex);
      if (prev === null) return;
      goToChapter(prev);
    },

    nextChapter() {
      const next = nextChapterIndex(chapterIndex, chapters.length);
      if (next === null) return;
      goToChapter(next);
    },

    seek(seconds) {
      const clamped = Math.max(0, seconds);
      audio.setCurrentTime(clamped);
      currentTime = clamped;
      emit();
    },

    onLoadedMetadata() {
      const d = audio.getDuration();
      duration = Number.isFinite(d) && d > 0 ? d : 0;
      if (pendingSeekSeconds > 0) {
        const target =
          duration > 0
            ? Math.min(pendingSeekSeconds, duration)
            : pendingSeekSeconds;
        audio.setCurrentTime(target);
        currentTime = target;
        pendingSeekSeconds = 0;
      }
      emit();
    },

    onTimeUpdate() {
      currentTime = audio.getCurrentTime();
      const now = clock.now();
      if (lastSavedAt === 0 || now - lastSavedAt >= saveIntervalMs) {
        lastSavedAt = now;
        persist(currentTime);
      }
      emit();
    },

    onPlay() {
      isPlaying = true;
      emit();
    },

    onPause() {
      isPlaying = false;
      emit();
    },

    onEnded() {
      const endPos = duration > 0 ? duration : audio.getCurrentTime();
      persist(endPos);
      lastSavedAt = clock.now();
      const next = nextChapterIndex(chapterIndex, chapters.length);
      if (next !== null) {
        goToChapter(next);
      } else {
        isPlaying = false;
        currentTime = endPos;
        emit();
      }
    },

    flush() {
      if (!currentChapter()) return;
      persist(audio.getCurrentTime());
      lastSavedAt = clock.now();
    },
  };
}

/**
 * Production AudioPort bound to a lazily-resolved HTMLAudioElement
 * (ref may be null until the chrome mounts).
 */
function createHtmlAudioPort(
  getAudio: () => HTMLAudioElement | null
): AudioPort {
  return {
    play() {
      const el = getAudio();
      if (!el) return Promise.resolve();
      return el.play();
    },
    pause() {
      getAudio()?.pause();
    },
    getCurrentTime() {
      return getAudio()?.currentTime ?? 0;
    },
    setCurrentTime(seconds) {
      const el = getAudio();
      if (el) el.currentTime = seconds;
    },
    getDuration() {
      const d = getAudio()?.duration;
      return d != null && Number.isFinite(d) ? d : 0;
    },
    isPaused() {
      const el = getAudio();
      return el ? el.paused : true;
    },
  };
}

/**
 * Bindable HTML audio port: hides element mutability inside the adapter so
 * React providers can construct policy once without render-time refs.
 */
export function createBindableHtmlAudioPort(): {
  port: AudioPort;
  bind: (el: HTMLAudioElement | null) => void;
} {
  let element: HTMLAudioElement | null = null;
  return {
    port: createHtmlAudioPort(() => element),
    bind(el) {
      element = el;
    },
  };
}

/** Build the san-citro-media URL for a chapter (chrome / protocol concern). */
export function mediaUrlForChapter(md5: string, chapterId: number): string {
  return `san-citro-media://${md5}/${chapterId}`;
}
