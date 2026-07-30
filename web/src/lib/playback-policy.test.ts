/**
 * Playback policy tests (CONTEXT: Playback policy; ADR-0013).
 *
 * Run: npx tsx --test src/lib/playback-policy.test.ts  (from web/)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SAVE_INTERVAL_MS,
  createPlaybackPolicy,
  mediaUrlForChapter,
  nextChapterIndex,
  prevChapterIndex,
  resolveResume,
  type AudioPort,
  type PlaybackClock,
  type PlaybackPolicy,
  type ProgressStore,
} from "./playback-policy";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createFakeAudio(initial?: {
  currentTime?: number;
  duration?: number;
  paused?: boolean;
}): AudioPort & {
  currentTime: number;
  duration: number;
  paused: boolean;
  playCalls: number;
  pauseCalls: number;
} {
  const state = {
    currentTime: initial?.currentTime ?? 0,
    duration: initial?.duration ?? 0,
    paused: initial?.paused ?? true,
    playCalls: 0,
    pauseCalls: 0,
  };

  const port: AudioPort & typeof state = {
    get currentTime() {
      return state.currentTime;
    },
    set currentTime(v: number) {
      state.currentTime = v;
    },
    get duration() {
      return state.duration;
    },
    set duration(v: number) {
      state.duration = v;
    },
    get paused() {
      return state.paused;
    },
    set paused(v: boolean) {
      state.paused = v;
    },
    get playCalls() {
      return state.playCalls;
    },
    get pauseCalls() {
      return state.pauseCalls;
    },
    play() {
      state.playCalls += 1;
      state.paused = false;
      return Promise.resolve();
    },
    pause() {
      state.pauseCalls += 1;
      state.paused = true;
    },
    getCurrentTime() {
      return state.currentTime;
    },
    setCurrentTime(seconds: number) {
      state.currentTime = seconds;
    },
    getDuration() {
      return state.duration;
    },
    isPaused() {
      return state.paused;
    },
  };

  return port;
}

function createMemoryProgressStore(): ProgressStore & {
  saves: Array<{
    md5: string;
    chapter_id: number;
    file_position_seconds: number;
  }>;
} {
  const saves: Array<{
    md5: string;
    chapter_id: number;
    file_position_seconds: number;
  }> = [];
  return {
    saves,
    save(input) {
      saves.push({ ...input });
    },
  };
}

function createFakeClock(start = 0): PlaybackClock & { advance(ms: number): void; t: number } {
  let t = start;
  return {
    get t() {
      return t;
    },
    now() {
      return t;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

const CHAPTERS = [
  { chapter_id: 10 },
  { chapter_id: 20 },
  { chapter_id: 30 },
];

function loadThree(
  policy: PlaybackPolicy,
  progress: { chapter_id: number; file_position_seconds: number } | null = null
) {
  policy.loadSession({
    md5: "abc123",
    chapters: CHAPTERS,
    progress,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("resolveResume", () => {
  test("null progress starts at chapter 0 position 0", () => {
    assert.deepEqual(resolveResume(CHAPTERS, null), {
      chapterIndex: 0,
      positionSeconds: 0,
    });
  });

  test("matches chapter_id and resumes position", () => {
    assert.deepEqual(
      resolveResume(CHAPTERS, { chapter_id: 20, file_position_seconds: 42.9 }),
      { chapterIndex: 1, positionSeconds: 42.9 }
    );
  });

  test("unknown chapter_id falls back to start", () => {
    assert.deepEqual(
      resolveResume(CHAPTERS, { chapter_id: 999, file_position_seconds: 10 }),
      { chapterIndex: 0, positionSeconds: 0 }
    );
  });

  test("empty chapters yields index 0", () => {
    assert.deepEqual(
      resolveResume([], { chapter_id: 10, file_position_seconds: 5 }),
      { chapterIndex: 0, positionSeconds: 0 }
    );
  });

  test("negative position clamps to 0", () => {
    assert.deepEqual(
      resolveResume(CHAPTERS, { chapter_id: 10, file_position_seconds: -3 }),
      { chapterIndex: 0, positionSeconds: 0 }
    );
  });
});

describe("nextChapterIndex / prevChapterIndex", () => {
  test("advances until last, then null", () => {
    assert.equal(nextChapterIndex(0, 3), 1);
    assert.equal(nextChapterIndex(1, 3), 2);
    assert.equal(nextChapterIndex(2, 3), null);
    assert.equal(nextChapterIndex(0, 0), null);
  });

  test("prev until first, then null", () => {
    assert.equal(prevChapterIndex(2), 1);
    assert.equal(prevChapterIndex(1), 0);
    assert.equal(prevChapterIndex(0), null);
  });
});

describe("mediaUrlForChapter", () => {
  test("builds san-citro-media URL", () => {
    assert.equal(
      mediaUrlForChapter("deadbeef", 7),
      "san-citro-media://deadbeef/7"
    );
  });
});

// ---------------------------------------------------------------------------
// Policy with fakes
// ---------------------------------------------------------------------------

describe("createPlaybackPolicy", () => {
  test("loadSession resumes chapter index and pending seek", () => {
    const audio = createFakeAudio();
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy, { chapter_id: 30, file_position_seconds: 15 });

    const snap = policy.getSnapshot();
    assert.equal(snap.md5, "abc123");
    assert.equal(snap.chapterIndex, 2);
    assert.equal(snap.pendingSeekSeconds, 15);
    assert.equal(snap.active, true);
    assert.equal(snap.isPlaying, false);
  });

  test("onLoadedMetadata applies pending seek clamped to duration", () => {
    const audio = createFakeAudio({ duration: 100 });
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy, { chapter_id: 10, file_position_seconds: 40 });
    policy.onLoadedMetadata();

    assert.equal(audio.currentTime, 40);
    assert.equal(policy.getSnapshot().currentTime, 40);
    assert.equal(policy.getSnapshot().duration, 100);
    assert.equal(policy.getSnapshot().pendingSeekSeconds, 0);
  });

  test("onLoadedMetadata clamps seek past duration", () => {
    const audio = createFakeAudio({ duration: 30 });
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy, { chapter_id: 10, file_position_seconds: 999 });
    policy.onLoadedMetadata();

    assert.equal(audio.currentTime, 30);
    assert.equal(policy.getSnapshot().pendingSeekSeconds, 0);
  });

  test("save cadence persists on first timeupdate and after interval", () => {
    const audio = createFakeAudio({ duration: 200, currentTime: 5 });
    const store = createMemoryProgressStore();
    const clock = createFakeClock(1000);
    const policy = createPlaybackPolicy({
      audio,
      progress: store,
      clock,
      saveIntervalMs: SAVE_INTERVAL_MS,
    });

    loadThree(policy);
    policy.onLoadedMetadata();

    audio.currentTime = 5;
    policy.onTimeUpdate();
    assert.equal(store.saves.length, 1);
    assert.deepEqual(store.saves[0], {
      md5: "abc123",
      chapter_id: 10,
      file_position_seconds: 5,
    });

    // Within interval — no extra save
    audio.currentTime = 8;
    clock.advance(SAVE_INTERVAL_MS - 1);
    policy.onTimeUpdate();
    assert.equal(store.saves.length, 1);

    // At/after interval — save again
    audio.currentTime = 12.7;
    clock.advance(1);
    policy.onTimeUpdate();
    assert.equal(store.saves.length, 2);
    assert.equal(store.saves[1].file_position_seconds, 12);
  });

  test("onEnded advances to next chapter and saves end position", () => {
    const audio = createFakeAudio({ duration: 60, currentTime: 60 });
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy);
    policy.onLoadedMetadata();
    policy.onPlay();
    assert.equal(policy.getSnapshot().isPlaying, true);

    policy.onEnded();

    assert.equal(store.saves.length, 1);
    assert.deepEqual(store.saves[0], {
      md5: "abc123",
      chapter_id: 10,
      file_position_seconds: 60,
    });
    assert.equal(policy.getSnapshot().chapterIndex, 1);
    assert.equal(policy.getSnapshot().pendingSeekSeconds, 0);
  });

  test("onEnded on last chapter stops without advancing", () => {
    const audio = createFakeAudio({ duration: 45, currentTime: 45 });
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy, { chapter_id: 30, file_position_seconds: 0 });
    policy.onLoadedMetadata();
    policy.onPlay();

    policy.onEnded();

    assert.equal(policy.getSnapshot().chapterIndex, 2);
    assert.equal(policy.getSnapshot().isPlaying, false);
    assert.equal(store.saves[0].chapter_id, 30);
  });

  test("goToChapter / prev / next bound chapter index", () => {
    const audio = createFakeAudio();
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy);
    policy.nextChapter();
    assert.equal(policy.getSnapshot().chapterIndex, 1);
    policy.nextChapter();
    assert.equal(policy.getSnapshot().chapterIndex, 2);
    policy.nextChapter(); // no-op at end
    assert.equal(policy.getSnapshot().chapterIndex, 2);

    policy.prevChapter();
    assert.equal(policy.getSnapshot().chapterIndex, 1);
    policy.goToChapter(0, 12);
    assert.equal(policy.getSnapshot().chapterIndex, 0);
    assert.equal(policy.getSnapshot().pendingSeekSeconds, 12);

    policy.goToChapter(-1);
    policy.goToChapter(99);
    assert.equal(policy.getSnapshot().chapterIndex, 0);
  });

  test("togglePlay uses AudioPort play/pause", async () => {
    const audio = createFakeAudio();
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy);
    policy.togglePlay();
    await Promise.resolve();
    assert.equal(audio.playCalls, 1);
    assert.equal(audio.paused, false);

    policy.togglePlay();
    assert.equal(audio.pauseCalls, 1);
    assert.equal(audio.paused, true);
  });

  test("flush persists current audio position", () => {
    const audio = createFakeAudio({ currentTime: 33.8 });
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy, { chapter_id: 20, file_position_seconds: 0 });
    policy.flush();

    assert.deepEqual(store.saves[0], {
      md5: "abc123",
      chapter_id: 20,
      file_position_seconds: 33,
    });
  });

  test("clearSession deactivates and flush becomes no-op", () => {
    const audio = createFakeAudio({ currentTime: 10 });
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    loadThree(policy);
    policy.clearSession();
    assert.equal(policy.getSnapshot().active, false);
    assert.equal(policy.getSnapshot().md5, null);

    policy.flush();
    assert.equal(store.saves.length, 0);
  });

  test("subscribe notifies on session load", () => {
    const audio = createFakeAudio();
    const store = createMemoryProgressStore();
    const policy = createPlaybackPolicy({ audio, progress: store });

    const seen: number[] = [];
    const unsub = policy.subscribe((s) => seen.push(s.chapterIndex));
    loadThree(policy, { chapter_id: 20, file_position_seconds: 0 });
    assert.deepEqual(seen, [1]);
    unsub();
    policy.nextChapter();
    assert.deepEqual(seen, [1]);
  });

  test("SAVE_INTERVAL_MS default is 5 seconds", () => {
    assert.equal(SAVE_INTERVAL_MS, 5000);
  });
});
