/**
 * Active downloads session store tests.
 *
 * Run: npx tsx --test src/lib/active-downloads.test.ts  (from web/)
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  TERMINAL_RETENTION_MS,
  createActiveDownloadsStore,
  evictionDelayMs,
  isLiveActiveStatus,
  isTerminalStatus,
  type ActiveDownloadsTimers,
  type TimerHandle,
} from "./active-downloads";
import type { DownloadStatus } from "@/types";

// ---------------------------------------------------------------------------
// Fake timers + injectable clock
// ---------------------------------------------------------------------------

function createFakeTimers(): {
  timers: ActiveDownloadsTimers;
  advance(ms: number): void;
  pendingCount(): number;
  nowMs(): number;
  setNowMs(ms: number): void;
} {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; due: number }>();
  let now = 0;

  const timers: ActiveDownloadsTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, due: now + ms });
      return id as unknown as TimerHandle;
    },
    clearTimeout(id) {
      pending.delete(id as unknown as number);
    },
  };

  return {
    timers,
    nowMs() {
      return now;
    },
    setNowMs(ms: number) {
      now = ms;
    },
    advance(ms: number) {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, t]) => t.due <= now)
        .sort((a, b) => a[1].due - b[1].due);
      for (const [id, t] of due) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        t.fn();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}

function dl(
  md5: string,
  status: DownloadStatus["status"],
  overrides: Partial<DownloadStatus> = {}
): DownloadStatus {
  return {
    md5,
    title: overrides.title ?? md5,
    status,
    progress_percent: overrides.progress_percent ?? 0,
    total_bytes: overrides.total_bytes ?? 0,
    downloaded_bytes: overrides.downloaded_bytes ?? 0,
    error: overrides.error ?? null,
    filename: overrides.filename ?? null,
    file_path: overrides.file_path ?? null,
    started_at: overrides.started_at ?? null,
    terminal_at: overrides.terminal_at,
    terminal_expires_at: overrides.terminal_expires_at,
  };
}

/** Terminal payload with backend-owned deadline (seconds). */
function terminal(
  md5: string,
  status: "completed" | "failed" | "cancelled",
  expiresAtSec: number,
  overrides: Partial<DownloadStatus> = {}
): DownloadStatus {
  return dl(md5, status, {
    terminal_at: expiresAtSec - 300,
    terminal_expires_at: expiresAtSec,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isTerminalStatus / isLiveActiveStatus", () => {
  test("classifies lifecycle terminals and live states", () => {
    assert.equal(isTerminalStatus("completed"), true);
    assert.equal(isTerminalStatus("failed"), true);
    assert.equal(isTerminalStatus("cancelled"), true);
    assert.equal(isTerminalStatus("downloading"), false);
    assert.equal(isLiveActiveStatus("queued"), true);
    assert.equal(isLiveActiveStatus("downloading"), true);
    // Legacy DB/IPC "started" normalizes to downloading (not a public live status).
    assert.equal(isLiveActiveStatus("started"), true);
    assert.equal(isLiveActiveStatus("completed"), false);
  });

  test("hydrate coerces legacy started status to downloading", () => {
    const fake = createFakeTimers();
    const store = createActiveDownloadsStore({
      timers: fake.timers,
      now: () => fake.nowMs(),
    });
    // Simulate pre-cleanup IPC payload that still said "started".
    const legacy = {
      md5: "a".repeat(32),
      title: "Legacy",
      status: "started",
      progress_percent: 0,
      total_bytes: 0,
      downloaded_bytes: 0,
      error: null,
      filename: null,
      file_path: null,
      started_at: null,
    } as unknown as DownloadStatus;
    store.hydrate([legacy]);
    assert.equal(store.getByMd5("a".repeat(32))?.status, "downloading");
    store.reset();
  });
});

describe("evictionDelayMs (contract with backend deadline)", () => {
  test("uses remaining duration from terminal_expires_at, not a full local window", () => {
    const nowMs = 1_000_000;
    // Expires 40s from now → 40_000ms remaining (not a fresh 60s/300s window).
    assert.equal(evictionDelayMs({ terminal_expires_at: 1040 }, nowMs, 60_000), 40_000);
  });

  test("clamps overdue deadline to 0", () => {
    assert.equal(evictionDelayMs({ terminal_expires_at: 10 }, 20_000, 60_000), 0);
  });

  test("falls back only when field is absent", () => {
    assert.equal(evictionDelayMs({}, 0, 12_345), 12_345);
    assert.equal(evictionDelayMs({ terminal_expires_at: null }, 0, 12_345), 12_345);
    assert.equal(evictionDelayMs({ terminal_expires_at: undefined }, 0, 12_345), 12_345);
  });
});

describe("createActiveDownloadsStore", () => {
  const stores: ReturnType<typeof createActiveDownloadsStore>[] = [];

  afterEach(() => {
    for (const s of stores) s.reset();
    stores.length = 0;
  });

  function makeStore(fallbackRetentionMs = TERMINAL_RETENTION_MS) {
    const fake = createFakeTimers();
    // Align wall clock with fake timer epoch so deadline math is deterministic.
    fake.setNowMs(1_700_000_000_000);
    const store = createActiveDownloadsStore({
      timers: fake.timers,
      retentionMs: fallbackRetentionMs,
      now: () => fake.nowMs(),
    });
    stores.push(store);
    return { store, fake };
  }

  test("hydrate seeds the map and selector-by-md5", () => {
    const { store } = makeStore();
    store.hydrate([
      dl("a".repeat(32), "queued"),
      dl("b".repeat(32), "downloading", { progress_percent: 10 }),
    ]);

    assert.equal(store.getSnapshot().downloads.size, 2);
    assert.equal(store.getByMd5("a".repeat(32))?.status, "queued");
    assert.equal(store.getByMd5("b".repeat(32))?.progress_percent, 10);
    assert.equal(store.getByMd5("c".repeat(32)), undefined);
  });

  test("applyProgress upserts and notifies subscribers once per batch", () => {
    const { store } = makeStore();
    const snaps: number[] = [];
    store.subscribe((s) => snaps.push(s.downloads.size));

    store.applyProgress(dl("a".repeat(32), "queued"));
    store.applyProgress([
      dl("a".repeat(32), "downloading", { progress_percent: 50, downloaded_bytes: 50 }),
      dl("b".repeat(32), "queued"),
    ]);

    assert.equal(store.getByMd5("a".repeat(32))?.status, "downloading");
    assert.equal(store.getByMd5("a".repeat(32))?.progress_percent, 50);
    assert.equal(store.getSnapshot().downloads.size, 2);
    assert.deepEqual(snaps, [1, 2]);
  });

  test("terminal retention honors backend terminal_expires_at deadline", () => {
    const { store, fake } = makeStore(60_000);
    const nowSec = fake.nowMs() / 1000;
    const expiresAt = nowSec + 1; // 1000ms remaining
    store.applyProgress(
      terminal("a".repeat(32), "completed", expiresAt, { filename: "x.epub" })
    );
    assert.equal(store.getSnapshot().downloads.size, 1);

    fake.advance(999);
    assert.equal(store.getSnapshot().downloads.size, 1);

    fake.advance(1);
    assert.equal(store.getSnapshot().downloads.size, 0);
    assert.equal(store.getByMd5("a".repeat(32)), undefined);
  });

  test("long-running download remains full retention after completion (deadline based)", () => {
    const { store, fake } = makeStore(1); // fallback would wrongly be 1ms if used
    const nowSec = fake.nowMs() / 1000;
    // started long ago; terminal just now; retention window is 300s on backend
    const startedAt = nowSec - 600;
    const expiresAt = nowSec + 300;
    store.applyProgress(
      dl("a".repeat(32), "completed", {
        started_at: startedAt,
        terminal_at: nowSec,
        terminal_expires_at: expiresAt,
      })
    );
    // Must not vanish immediately despite old started_at / tiny fallback.
    fake.advance(299_000);
    assert.equal(store.getSnapshot().downloads.size, 1);
    fake.advance(1_000);
    assert.equal(store.getSnapshot().downloads.size, 0);
  });

  test("hydrating terminal item mid-window evicts after remaining duration", () => {
    const { store, fake } = makeStore(300_000);
    const nowSec = fake.nowMs() / 1000;
    // Originally expired 300s after terminal; 100s already elapsed → 200s left.
    const expiresAt = nowSec + 200;
    store.hydrate([
      terminal("a".repeat(32), "completed", expiresAt, {
        terminal_at: expiresAt - 300,
      }),
    ]);
    assert.equal(store.getSnapshot().downloads.size, 1);

    // Full fallback window (300s) must NOT be used — only remaining 200s.
    fake.advance(199_000);
    assert.equal(store.getSnapshot().downloads.size, 1);
    fake.advance(1_000);
    assert.equal(store.getSnapshot().downloads.size, 0);
  });

  test("fallback retention when terminal_expires_at absent (legacy bridge)", () => {
    const { store, fake } = makeStore(1_000);
    store.applyProgress(dl("a".repeat(32), "completed", { filename: "x.epub" }));
    assert.equal(store.getSnapshot().downloads.size, 1);
    fake.advance(999);
    assert.equal(store.getSnapshot().downloads.size, 1);
    fake.advance(1);
    assert.equal(store.getSnapshot().downloads.size, 0);
  });

  test("completedThisSession survives live-list retention", () => {
    const { store, fake } = makeStore(100);
    const md5 = "a".repeat(32);
    const expiresAt = fake.nowMs() / 1000 + 0.1;
    store.applyProgress(terminal(md5, "completed", expiresAt));
    assert.equal(store.getSnapshot().completedThisSession.has(md5), true);

    fake.advance(100);
    assert.equal(store.getSnapshot().downloads.has(md5), false);
    assert.equal(store.getSnapshot().completedThisSession.has(md5), true);
  });

  test("failed and cancelled are terminal and retain then evict", () => {
    const { store, fake } = makeStore(50);
    const expiresAt = fake.nowMs() / 1000 + 0.05;
    store.applyProgress([
      terminal("f".repeat(32), "failed", expiresAt, { error: "boom" }),
      terminal("c".repeat(32), "cancelled", expiresAt),
    ]);
    assert.equal(store.getSnapshot().downloads.size, 2);
    fake.advance(50);
    assert.equal(store.getSnapshot().downloads.size, 0);
    // only completed enters completedThisSession
    assert.equal(store.getSnapshot().completedThisSession.size, 0);
  });

  test("removeDownloads clears entries and cancels retention timers", () => {
    const { store, fake } = makeStore(5_000);
    const expiresAt = fake.nowMs() / 1000 + 5;
    store.applyProgress(terminal("a".repeat(32), "completed", expiresAt));
    assert.equal(fake.pendingCount(), 1);

    store.removeDownloads(["a".repeat(32)]);
    assert.equal(store.getSnapshot().downloads.size, 0);
    assert.equal(fake.pendingCount(), 0);

    fake.advance(5_000);
    assert.equal(store.getSnapshot().downloads.size, 0);
  });

  test("non-terminal progress after terminal cancels eviction (retry)", () => {
    const { store, fake } = makeStore(100);
    const md5 = "a".repeat(32);
    const expiresAt = fake.nowMs() / 1000 + 0.1;
    store.applyProgress(terminal(md5, "failed", expiresAt));
    store.applyProgress(dl(md5, "queued")); // retry — no terminal_expires_at
    fake.advance(100);
    assert.equal(store.getByMd5(md5)?.status, "queued");
    assert.equal(fake.pendingCount(), 0);
  });

  test("setConnection updates snapshot without touching downloads", () => {
    const { store } = makeStore();
    store.hydrate([dl("a".repeat(32), "queued")]);
    store.setConnection("connected");
    assert.equal(store.getSnapshot().connection, "connected");
    assert.equal(store.getSnapshot().downloads.size, 1);
    store.setConnection("disconnected");
    assert.equal(store.getSnapshot().connection, "disconnected");
  });

  test("subscribe unsubscribe stops notifications", () => {
    const { store } = makeStore();
    let count = 0;
    const unsub = store.subscribe(() => {
      count += 1;
    });
    store.applyProgress(dl("a".repeat(32), "queued"));
    unsub();
    store.applyProgress(dl("a".repeat(32), "downloading"));
    assert.equal(count, 1);
    assert.equal(store.getByMd5("a".repeat(32))?.status, "downloading");
  });

  test("fallback constant is documented and not the dual-maintained primary", () => {
    // Primary path uses terminal_expires_at; this constant is temporary only.
    assert.equal(typeof TERMINAL_RETENTION_MS, "number");
    assert.ok(TERMINAL_RETENTION_MS > 0);
  });
});
