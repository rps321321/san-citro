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
  isLiveActiveStatus,
  isTerminalStatus,
  type ActiveDownloadsTimers,
  type TimerHandle,
} from "./active-downloads";
import type { DownloadStatus } from "@/types";

// ---------------------------------------------------------------------------
// Fake timers
// ---------------------------------------------------------------------------

function createFakeTimers(): {
  timers: ActiveDownloadsTimers;
  advance(ms: number): void;
  pendingCount(): number;
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
  };
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
    assert.equal(isLiveActiveStatus("started"), true);
    assert.equal(isLiveActiveStatus("completed"), false);
  });
});

describe("createActiveDownloadsStore", () => {
  const stores: ReturnType<typeof createActiveDownloadsStore>[] = [];

  afterEach(() => {
    for (const s of stores) s.reset();
    stores.length = 0;
  });

  function makeStore(retentionMs = TERMINAL_RETENTION_MS) {
    const fake = createFakeTimers();
    const store = createActiveDownloadsStore({
      timers: fake.timers,
      retentionMs,
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

  test("terminal retention removes from live list after retentionMs", () => {
    const { store, fake } = makeStore(1_000);
    store.applyProgress(dl("a".repeat(32), "completed", { filename: "x.epub" }));
    assert.equal(store.getSnapshot().downloads.size, 1);

    fake.advance(999);
    assert.equal(store.getSnapshot().downloads.size, 1);

    fake.advance(1);
    assert.equal(store.getSnapshot().downloads.size, 0);
    assert.equal(store.getByMd5("a".repeat(32)), undefined);
  });

  test("completedThisSession survives live-list retention", () => {
    const { store, fake } = makeStore(100);
    const md5 = "a".repeat(32);
    store.applyProgress(dl(md5, "completed"));
    assert.equal(store.getSnapshot().completedThisSession.has(md5), true);

    fake.advance(100);
    assert.equal(store.getSnapshot().downloads.has(md5), false);
    assert.equal(store.getSnapshot().completedThisSession.has(md5), true);
  });

  test("failed and cancelled are terminal and retain then evict", () => {
    const { store, fake } = makeStore(50);
    store.applyProgress([
      dl("f".repeat(32), "failed", { error: "boom" }),
      dl("c".repeat(32), "cancelled"),
    ]);
    assert.equal(store.getSnapshot().downloads.size, 2);
    fake.advance(50);
    assert.equal(store.getSnapshot().downloads.size, 0);
    // only completed enters completedThisSession
    assert.equal(store.getSnapshot().completedThisSession.size, 0);
  });

  test("removeDownloads clears entries and cancels retention timers", () => {
    const { store, fake } = makeStore(5_000);
    store.applyProgress(dl("a".repeat(32), "completed"));
    assert.equal(fake.pendingCount(), 1);

    store.removeDownloads(["a".repeat(32)]);
    assert.equal(store.getSnapshot().downloads.size, 0);
    assert.equal(fake.pendingCount(), 0);

    fake.advance(5_000);
    assert.equal(store.getSnapshot().downloads.size, 0);
  });

  test("non-terminal progress after terminal cancels eviction", () => {
    const { store, fake } = makeStore(100);
    const md5 = "a".repeat(32);
    store.applyProgress(dl(md5, "failed"));
    store.applyProgress(dl(md5, "queued")); // retry
    fake.advance(100);
    assert.equal(store.getByMd5(md5)?.status, "queued");
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

  test("default retention matches TERMINAL_RETENTION_MS constant", () => {
    assert.equal(TERMINAL_RETENTION_MS, 60_000);
  });
});
