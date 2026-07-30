/**
 * Renderer telemetry deep-module tests.
 *
 * Run: npx tsx --test src/lib/telemetry.test.ts  (from web/)
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ORDINARY_BATCH_INTERVAL_MS,
  ORDINARY_MAX_BATCH_SIZE,
  __getOrdinaryQueueLengthForTests,
  __resetTelemetryStateForTests,
  __rotateSessionIdForTests,
  __setTelemetryConfiguredForTests,
  __setTelemetryTimersForTests,
  __setTelemetryTransportForTests,
  endSession,
  flushEngagement,
  flushTelemetry,
  getDeviceId,
  getSessionId,
  incrementEngagement,
  startSession,
  submitClickHeatmap,
  submitMouseTracking,
  submitReplayChunk,
  submitScrollDepth,
  trackBridgeCall,
  trackError,
  trackEvent,
  trackFeatureDiscovery,
  trackFunnelStep,
  trackInteraction,
  trackPageView,
  trackReadingProgress,
  trackSearch,
  trackSettingsChange,
  trackSystemSnapshot,
  type TelemetryTransport,
} from "./telemetry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Delivered {
  table: string;
  rows: Record<string, unknown>[];
}

function createCaptureTransport(): {
  delivered: Delivered[];
  transport: TelemetryTransport;
} {
  const delivered: Delivered[] = [];
  const transport: TelemetryTransport = async (table, rows) => {
    delivered.push({
      table,
      rows: rows.map((r) => ({ ...r })),
    });
  };
  return { delivered, transport };
}

function createThrowingTransport(): TelemetryTransport {
  return async () => {
    throw new Error("network down");
  };
}

/** Drain microtasks so void deliverImmediate() settles. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetTelemetryStateForTests();
});

afterEach(() => {
  __resetTelemetryStateForTests();
  // Clean any window stub from handoff tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.window && g.__telemetryTestWindow) {
    delete g.window;
    delete g.__telemetryTestWindow;
  }
});

// ---------------------------------------------------------------------------
// Ordinary facts → table + shared context
// ---------------------------------------------------------------------------

describe("ordinary fact categories", () => {
  test("trackEvent maps to events with shared context", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    const session = getSessionId();
    trackEvent("foo", { a: 1 });
    flushTelemetry();
    await settle();

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].table, "events");
    assert.equal(delivered[0].rows.length, 1);
    const row = delivered[0].rows[0];
    assert.equal(row.event_name, "foo");
    assert.deepEqual(row.event_data, { a: 1 });
    assert.equal(row.session_id, session);
    assert.equal(row.device_id, getDeviceId());
    assert.ok("app_version" in row);
  });

  test("trackSearch / trackError / trackPageView / trackInteraction map correctly", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    trackSearch({
      query: "quantum",
      resultCount: 3,
      responseTimeMs: 120,
      extension: "epub",
    });
    trackError("ipc", "boom", { component: "bridge" });
    trackPageView("/library");
    trackInteraction("click", "download", { md5: "abc" });
    flushTelemetry();
    await settle();

    const byTable = Object.fromEntries(
      delivered.map((d) => [d.table, d.rows[0]])
    );

    assert.equal(byTable.search_analytics.query, "quantum");
    assert.equal(byTable.search_analytics.extension_filter, "epub");
    assert.equal(byTable.search_analytics.result_count, 3);

    assert.equal(byTable.errors.error_type, "ipc");
    assert.equal(byTable.errors.error_message, "boom");
    assert.equal(byTable.errors.component, "bridge");

    assert.equal(byTable.page_views.page_path, "/library");

    assert.equal(byTable.interactions.action, "click");
    assert.equal(byTable.interactions.target, "download");

    // Shared identity on every ordinary row
    for (const table of [
      "search_analytics",
      "errors",
      "page_views",
      "interactions",
    ]) {
      assert.equal(byTable[table].session_id, getSessionId());
      assert.equal(byTable[table].device_id, getDeviceId());
      assert.ok("app_version" in byTable[table]);
    }
  });

  test("reading / system / funnel / bridge / feature / settings use typed inputs + shared context", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    const session = getSessionId();
    const device = getDeviceId();

    trackReadingProgress({
      md5: "deadbeef",
      title: "Sample Book",
      event: "progress",
      progressPercent: 42,
      chapter: "3",
      elapsedSeconds: 90,
    });
    trackSystemSnapshot({
      ramTotalMb: 8192,
      cpuCores: 8,
      screenWidth: 1920,
      screenHeight: 1080,
    });
    trackFunnelStep("search_to_download", "search_performed", 1, {
      query: "q",
    });
    trackBridgeCall({
      method: "query_library",
      durationMs: 12,
      success: true,
      paramsSizeBytes: 10,
      responseSizeBytes: 200,
    });
    trackFeatureDiscovery("reader");
    trackFeatureDiscovery("reader"); // deduped — only one row
    trackSettingsChange("concurrency", "2", "4");

    // All of the above ordinary facts batch; none delivered yet
    assert.equal(__getOrdinaryQueueLengthForTests(), 6);

    flushTelemetry();
    await settle();

    assert.equal(__getOrdinaryQueueLengthForTests(), 0);

    const byTable = Object.fromEntries(
      delivered.map((d) => [d.table, d.rows[0]])
    );

    assert.equal(byTable.reading_progress.md5, "deadbeef");
    assert.equal(byTable.reading_progress.event, "progress");
    assert.equal(byTable.reading_progress.progress_percent, 42);
    assert.equal(byTable.reading_progress.chapter, "3");
    assert.equal(byTable.reading_progress.elapsed_seconds, 90);

    assert.equal(byTable.system_snapshots.ram_total_mb, 8192);
    assert.equal(byTable.system_snapshots.cpu_cores, 8);
    assert.equal(byTable.system_snapshots.screen_width, 1920);

    assert.equal(byTable.funnel_events.funnel_name, "search_to_download");
    assert.equal(byTable.funnel_events.step_name, "search_performed");
    assert.equal(byTable.funnel_events.step_index, 1);
    assert.deepEqual(byTable.funnel_events.metadata, { query: "q" });

    assert.equal(byTable.bridge_performance.method, "query_library");
    assert.equal(byTable.bridge_performance.duration_ms, 12);
    assert.equal(byTable.bridge_performance.success, true);
    assert.equal(byTable.bridge_performance.params_size_bytes, 10);

    assert.equal(byTable.feature_discovery.feature_name, "reader");
    assert.equal(
      delivered.find((d) => d.table === "feature_discovery")!.rows.length,
      1
    );

    assert.equal(byTable.settings_changes.setting_name, "concurrency");
    assert.equal(byTable.settings_changes.old_value, "2");
    assert.equal(byTable.settings_changes.new_value, "4");

    // Shared device / session / app_version stamped exactly once per row
    for (const table of [
      "reading_progress",
      "system_snapshots",
      "funnel_events",
      "bridge_performance",
      "feature_discovery",
      "settings_changes",
    ]) {
      const row = byTable[table];
      assert.equal(row.session_id, session);
      assert.equal(row.device_id, device);
      assert.ok("app_version" in row);
      // Context keys appear once at top level (not nested under a context blob)
      assert.equal(
        Object.keys(row).filter((k) => k === "session_id").length,
        1
      );
      assert.equal(
        Object.keys(row).filter((k) => k === "device_id").length,
        1
      );
      assert.equal(
        Object.keys(row).filter((k) => k === "app_version").length,
        1
      );
    }
  });

  test("ordinary facts do not re-stamp context at delivery", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    trackEvent("once");
    flushTelemetry();
    await settle();

    const row = delivered[0].rows[0];
    // Row shape is flat identity fields + event fields only
    assert.equal(row.event_name, "once");
    assert.ok(typeof row.session_id === "string");
    assert.ok(typeof row.device_id === "string");
    assert.ok(typeof row.app_version === "string");
    assert.equal("context" in row, false);
    assert.equal("telemetry_context" in row, false);
  });
});

// ---------------------------------------------------------------------------
// Heatmap + replay first-class facts
// ---------------------------------------------------------------------------

describe("heatmap and replay facts", () => {
  test("submitClickHeatmap uses identity context and click_heatmap table", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    submitClickHeatmap([
      {
        x: 10,
        y: 20,
        viewport_width: 800,
        viewport_height: 600,
        element_tag: "button",
        element_selector: "button#go",
        element_text: "Go",
        page_path: "/search",
      },
    ]);
    await settle();

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].table, "click_heatmap");
    const row = delivered[0].rows[0];
    assert.equal(row.x, 10);
    assert.equal(row.page_path, "/search");
    assert.equal(row.session_id, getSessionId());
    assert.equal(row.device_id, getDeviceId());
    // Heatmap identity context does not stamp app_version (preserve prior shape)
    assert.equal("app_version" in row, false);
  });

  test("submitScrollDepth / submitMouseTracking / submitReplayChunk map tables", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    submitScrollDepth({
      page_path: "/reader",
      max_depth_percent: 75,
      time_at_25_ms: 100,
      time_at_50_ms: 200,
      time_at_75_ms: 300,
      time_at_100_ms: 0,
      total_scroll_events: 0,
    });
    submitMouseTracking({
      page_path: "/reader",
      positions: [{ x: 1, y: 2, t: 0 }],
      sample_count: 1,
      duration_ms: 0,
    });
    submitReplayChunk({
      chunk_index: 0,
      events: [{ type: 2 }],
      event_count: 1,
      compressed_size_bytes: 12,
    });
    await settle();

    const tables = delivered.map((d) => d.table).sort();
    assert.deepEqual(tables, [
      "mouse_tracking",
      "replay_chunks",
      "scroll_depth",
    ]);

    const replay = delivered.find((d) => d.table === "replay_chunks")!;
    assert.equal(replay.rows[0].chunk_index, 0);
    assert.equal(replay.rows[0].event_count, 1);
    assert.equal(replay.rows[0].session_id, getSessionId());
  });

  test("heatmap/replay deliver immediately (not via ordinary batch queue)", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    trackEvent("queued-only");
    assert.equal(__getOrdinaryQueueLengthForTests(), 1);

    submitReplayChunk({
      chunk_index: 1,
      events: [],
      event_count: 0,
      compressed_size_bytes: 0,
    });
    // empty events still builds a row — wait, submitReplayChunk always sends one row
    await settle();

    // Ordinary event still queued
    assert.equal(__getOrdinaryQueueLengthForTests(), 1);
    // Replay already delivered
    assert.ok(delivered.some((d) => d.table === "replay_chunks"));
  });
});

// ---------------------------------------------------------------------------
// Batch / flush policies
// ---------------------------------------------------------------------------

describe("ordinary batch and flush policy", () => {
  test("flushTelemetry drains the ordinary queue", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    trackEvent("a");
    trackEvent("b");
    assert.equal(__getOrdinaryQueueLengthForTests(), 2);

    flushTelemetry();
    await settle();

    assert.equal(__getOrdinaryQueueLengthForTests(), 0);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].table, "events");
    assert.equal(delivered[0].rows.length, 2);
  });

  test("max batch size flushes without waiting for interval", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    for (let i = 0; i < ORDINARY_MAX_BATCH_SIZE; i++) {
      trackEvent(`e${i}`);
    }
    await settle();

    assert.equal(__getOrdinaryQueueLengthForTests(), 0);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].rows.length, ORDINARY_MAX_BATCH_SIZE);
  });

  test("batch interval timer flushes queued facts", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    const scheduled: { fn: (() => void) | null; ms: number } = {
      fn: null,
      ms: 0,
    };
    let handle: ReturnType<typeof setTimeout> | null = null;

    __setTelemetryTimersForTests({
      setTimeout: (fn, ms) => {
        scheduled.fn = fn;
        scheduled.ms = ms;
        // Real handle only for clearTimeout compatibility
        handle = setTimeout(() => {}, 60_000);
        return handle;
      },
      clearTimeout: (id) => clearTimeout(id),
    });

    trackEvent("timed");
    assert.equal(scheduled.ms, ORDINARY_BATCH_INTERVAL_MS);
    assert.ok(scheduled.fn);
    assert.equal(__getOrdinaryQueueLengthForTests(), 1);

    scheduled.fn();
    await settle();

    assert.equal(__getOrdinaryQueueLengthForTests(), 0);
    assert.equal(delivered[0].rows[0].event_name, "timed");

    if (handle) clearTimeout(handle);
  });

  test("endSession flushes ordinary queue (no durable state)", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    trackEvent("before-end");
    endSession(42);
    await settle();

    assert.equal(__getOrdinaryQueueLengthForTests(), 0);
    const eventRows = delivered
      .filter((d) => d.table === "events")
      .flatMap((d) => d.rows);
    const names = eventRows.map((r) => r.event_name);
    assert.ok(names.includes("before-end"));
    assert.ok(names.includes("session_end"));
  });
});

// ---------------------------------------------------------------------------
// Missing config / failures never throw
// ---------------------------------------------------------------------------

describe("resilience", () => {
  test("missing config is a silent no-op", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(false);

    trackEvent("nope");
    flushTelemetry();
    submitClickHeatmap([
      {
        x: 1,
        y: 1,
        viewport_width: 1,
        viewport_height: 1,
        element_tag: "div",
        element_selector: "div",
        element_text: "",
        page_path: "/",
      },
    ]);
    submitReplayChunk({
      chunk_index: 0,
      events: [],
      event_count: 0,
      compressed_size_bytes: 0,
    });
    await settle();

    assert.equal(delivered.length, 0);
  });

  test("transport failures never throw to callers", async () => {
    __setTelemetryTransportForTests(createThrowingTransport());
    __setTelemetryConfiguredForTests(true);

    assert.doesNotThrow(() => {
      trackEvent("x");
      flushTelemetry();
      submitScrollDepth({
        page_path: "/",
        max_depth_percent: 0,
        time_at_25_ms: 0,
        time_at_50_ms: 0,
        time_at_75_ms: 0,
        time_at_100_ms: 0,
        total_scroll_events: 0,
      });
      submitReplayChunk({
        chunk_index: 0,
        events: [],
        event_count: 0,
        compressed_size_bytes: 0,
      });
    });
    await settle();
  });

  test("empty click heatmap submit is a no-op", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    submitClickHeatmap([]);
    await settle();
    assert.equal(delivered.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Engagement + session handoff
// ---------------------------------------------------------------------------

describe("engagement and context handoff", () => {
  test("flushEngagement posts engagement_summary with counters", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    incrementEngagement("searchCount");
    incrementEngagement("searchCount");
    incrementEngagement("diagnosticsRun");
    flushEngagement(99);
    await settle();

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].table, "engagement_summary");
    const row = delivered[0].rows[0];
    assert.equal(row.duration_seconds, 99);
    assert.equal(row.search_count, 2);
    assert.equal(row.diagnostics_run, true);
    assert.equal(row.session_id, getSessionId());
  });

  test("startSession hands setTelemetryContext to Python bridge", async () => {
    const { delivered, transport } = createCaptureTransport();
    __setTelemetryTransportForTests(transport);
    __setTelemetryConfiguredForTests(true);

    const contextCalls: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    g.__telemetryTestWindow = true;
    g.window = {
      sanCitro: {
        setTelemetryContext: async (ctx: unknown) => {
          contextCalls.push(ctx);
        },
      },
      screen: { width: 100, height: 80 },
      devicePixelRatio: 1,
      addEventListener: () => {},
      // localStorage optional — getDeviceId falls back to "server"
    };

    const session = __rotateSessionIdForTests();
    startSession();
    await settle();

    assert.equal(contextCalls.length, 1);
    const ctx = contextCalls[0] as Record<string, string>;
    assert.equal(ctx.session_id, session);
    assert.equal(ctx.device_id, getDeviceId());
    assert.ok("app_version" in ctx);
    assert.ok("supabase_url" in ctx);
    assert.ok("anon_key" in ctx);

    // sessions table immediate insert
    assert.ok(delivered.some((d) => d.table === "sessions"));
  });

  test("startSession never throws when setTelemetryContext rejects", async () => {
    __setTelemetryTransportForTests(createCaptureTransport().transport);
    __setTelemetryConfiguredForTests(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    g.__telemetryTestWindow = true;
    g.window = {
      sanCitro: {
        setTelemetryContext: async () => {
          throw new Error("ipc fail");
        },
      },
      screen: {},
      devicePixelRatio: 1,
      addEventListener: () => {},
    };

    assert.doesNotThrow(() => startSession());
    await settle();
  });
});
