"use client";

/**
 * Telemetry deep module — single owner of renderer telemetry delivery.
 *
 * Capture modules submit **typed facts**. This module owns:
 * - table mapping + row construction
 * - shared telemetry context (device_id, session_id, app_version)
 * - auth headers + Supabase delivery
 * - ordinary batch queue / flush coordination
 * - first-class immediate delivery for heatmap + replay chunks
 *
 * Policies (ADR-0001–0003):
 * - Ordinary facts: batch ~30s or max 50
 * - Heatmap / replay: delivered when capture modules flush their own buffers
 * - Missing Supabase config → silent no-op
 * - Network / non-2xx → log, never throw into product
 * - Memory-only; no durable queue
 * - Renderer hands Python bridge context via setTelemetryContext at session start
 */

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isSupabaseConfigured,
} from "./supabase-config";

// ---------------------------------------------------------------------------
// Config / policy constants
// ---------------------------------------------------------------------------

const DEVICE_ID_KEY = "san-citro:device-id";
export const ORDINARY_BATCH_INTERVAL_MS = 30_000;
export const ORDINARY_MAX_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Device & Session IDs
// ---------------------------------------------------------------------------

function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = generateId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return "server";
  }
}

let sessionId = generateId();

// ---------------------------------------------------------------------------
// Injectible transport + test seams
// ---------------------------------------------------------------------------

/** Posts one table's rows to the remote sink. Must never throw into product code. */
export type TelemetryTransport = (
  table: string,
  rows: Record<string, unknown>[]
) => Promise<void>;

type TimerHandle = ReturnType<typeof setTimeout>;

interface TelemetryTimers {
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (id: TimerHandle) => void;
}

let injectedTransport: TelemetryTransport | null = null;
let configuredOverride: boolean | null = null;
let timers: TelemetryTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

function isConfigured(): boolean {
  if (configuredOverride !== null) return configuredOverride;
  return isSupabaseConfigured();
}

function defaultTransport(
  table: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[telemetry] Failed to send to ${table}: ${res.status} ${body}`
      );
    }
  });
}

function getTransport(): TelemetryTransport {
  return injectedTransport ?? defaultTransport;
}

/**
 * Deliver rows immediately (no ordinary batch queue).
 * Enriches nothing — callers (or fact helpers) own row shape.
 * Never throws; missing config is a no-op.
 */
async function deliverImmediate(
  table: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (!isConfigured() || rows.length === 0) return;
  try {
    await getTransport()(table, rows);
  } catch (err) {
    // Network failure — silently drop. Telemetry should never break the app.
    console.debug("[telemetry] Network error:", err);
  }
}

// ---------------------------------------------------------------------------
// Shared context helpers
// ---------------------------------------------------------------------------

function getAppVersion(): string {
  if (typeof window === "undefined") return "unknown";
  const api = window.sanCitro;
  if (api && "appVersion" in api) {
    return (api as unknown as { appVersion: string }).appVersion || "unknown";
  }
  return "unknown";
}

function getOsPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac")) return "macos";
  if (ua.includes("Linux")) return "linux";
  return "unknown";
}

/** Full context stamped on ordinary batched facts. */
function ordinaryContext(): {
  session_id: string;
  device_id: string;
  app_version: string;
} {
  return {
    session_id: sessionId,
    device_id: getDeviceId(),
    app_version: getAppVersion(),
  };
}

/** Identity context for heatmap / replay (matches prior row shapes). */
function identityContext(): { session_id: string; device_id: string } {
  return {
    session_id: sessionId,
    device_id: getDeviceId(),
  };
}

// ---------------------------------------------------------------------------
// Ordinary batched sender
// ---------------------------------------------------------------------------

interface QueuedInsert {
  table: string;
  row: Record<string, unknown>;
}

let queue: QueuedInsert[] = [];
let flushTimer: TimerHandle | null = null;

function flush(): void {
  if (queue.length === 0) return;

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const item of queue) {
    const existing = grouped.get(item.table) || [];
    existing.push(item.row);
    grouped.set(item.table, existing);
  }
  queue = [];

  if (flushTimer) {
    timers.clearTimeout(flushTimer);
    flushTimer = null;
  }

  for (const [table, rows] of grouped) {
    void deliverImmediate(table, rows);
  }
}

function enqueue(table: string, row: Record<string, unknown>): void {
  const enriched = {
    ...ordinaryContext(),
    ...row,
  };
  queue.push({ table, row: enriched });

  if (queue.length >= ORDINARY_MAX_BATCH_SIZE) {
    flush();
  } else if (!flushTimer) {
    flushTimer = timers.setTimeout(() => {
      flushTimer = null;
      flush();
    }, ORDINARY_BATCH_INTERVAL_MS);
  }
}

// Flush on page unload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (flushTimer) {
      timers.clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
  });
}

// ---------------------------------------------------------------------------
// Public fact API — ordinary product facts
// ---------------------------------------------------------------------------

/** Track a generic event */
export function trackEvent(name: string, data?: Record<string, unknown>): void {
  enqueue("events", {
    event_name: name,
    event_data: data || {},
    os_platform: getOsPlatform(),
  });
}

/** Track an error */
export function trackError(
  type: string,
  message: string,
  opts?: { stack?: string; component?: string }
): void {
  enqueue("errors", {
    error_type: type,
    error_message: message,
    error_stack: opts?.stack?.slice(0, 2000),
    component: opts?.component,
    os_platform: getOsPlatform(),
  });
}

/** Track a search */
export function trackSearch(opts: {
  query: string;
  extension?: string;
  language?: string;
  yearMin?: number;
  yearMax?: number;
  resultCount: number;
  responseTimeMs: number;
  page?: number;
}): void {
  enqueue("search_analytics", {
    query: opts.query.slice(0, 500),
    extension_filter: opts.extension || null,
    language_filter: opts.language || null,
    year_min: opts.yearMin || null,
    year_max: opts.yearMax || null,
    result_count: opts.resultCount,
    response_time_ms: opts.responseTimeMs,
    page_number: opts.page || 1,
  });
}

/** Track a page view */
export function trackPageView(path: string): void {
  enqueue("page_views", {
    page_path: path,
  });
}

/** Track a UI interaction (button click, toggle, etc.) */
export function trackInteraction(
  action: string,
  target?: string,
  metadata?: Record<string, unknown>
): void {
  enqueue("interactions", {
    action,
    target,
    metadata: metadata || {},
  });
}

/** Track an in-app reading session event (open / progress / closed). */
export function trackReadingProgress(opts: {
  md5: string;
  title?: string;
  event: "open" | "progress" | "closed";
  progressPercent?: number;
  chapter?: string;
  elapsedSeconds?: number;
}): void {
  enqueue("reading_progress", {
    md5: opts.md5,
    title: opts.title ?? null,
    event: opts.event,
    progress_percent: opts.progressPercent ?? null,
    chapter: opts.chapter ?? null,
    elapsed_seconds: opts.elapsedSeconds ?? null,
  });
}

/** Track system info snapshot (call once per session) */
export function trackSystemSnapshot(info: {
  ramTotalMb?: number;
  ramFreeMb?: number;
  cpuCores?: number;
  cpuModel?: string;
  screenWidth?: number;
  screenHeight?: number;
  screenScale?: number;
  diskFreeGb?: number;
  electronVersion?: string;
  nodeVersion?: string;
  pythonVersion?: string;
  chromeVersion?: string;
  osVersion?: string;
  osArch?: string;
  networkType?: string;
  proxyConfigured?: boolean;
}): void {
  enqueue("system_snapshots", {
    ram_total_mb: info.ramTotalMb,
    ram_free_mb: info.ramFreeMb,
    cpu_cores: info.cpuCores,
    cpu_model: info.cpuModel,
    screen_width: info.screenWidth,
    screen_height: info.screenHeight,
    screen_scale: info.screenScale,
    disk_free_gb: info.diskFreeGb,
    electron_version: info.electronVersion,
    node_version: info.nodeVersion,
    python_version: info.pythonVersion,
    chrome_version: info.chromeVersion,
    os_platform: getOsPlatform(),
    os_version: info.osVersion,
    os_arch: info.osArch,
    network_type: info.networkType,
    proxy_configured: info.proxyConfigured || false,
  });
}

/** Start a session (call on app mount) */
export function startSession(): void {
  // Send session start immediately (not batched)
  void deliverImmediate("sessions", [
    {
      id: sessionId,
      device_id: getDeviceId(),
      app_version: getAppVersion(),
      os_platform: getOsPlatform(),
      os_version: typeof navigator !== "undefined" ? navigator.userAgent : null,
    },
  ]);

  // Track system info
  if (typeof window !== "undefined") {
    trackSystemSnapshot({
      screenWidth: window.screen?.width,
      screenHeight: window.screen?.height,
      screenScale: window.devicePixelRatio,
      cpuCores: navigator.hardwareConcurrency,
    });
  }

  // Track daily activity (upsert)
  trackEvent("session_start");

  // Push telemetry context to Python bridge (fire-and-forget)
  try {
    window.sanCitro?.setTelemetryContext?.({
      device_id: getDeviceId(),
      session_id: sessionId,
      app_version: getAppVersion(),
      supabase_url: SUPABASE_URL,
      anon_key: SUPABASE_ANON_KEY,
    })?.catch(() => undefined);
  } catch {
    // never throw
  }
}

/** End a session */
export function endSession(durationSeconds: number): void {
  trackEvent("session_end", { duration_seconds: durationSeconds });
  flush(); // Ensure everything is sent before the app closes
}

/** Force flush all queued ordinary events */
export { flush as flushTelemetry };

/** Get session ID for correlation */
export function getSessionId(): string {
  return sessionId;
}

/** Get device ID for correlation */
export { getDeviceId };

// ---------------------------------------------------------------------------
// Deep telemetry — Funnels, Bridge, Engagement, Features
// ---------------------------------------------------------------------------

/** Track a step in a user journey funnel */
export function trackFunnelStep(
  funnel: string,
  step: string,
  index: number,
  metadata?: Record<string, unknown>
): void {
  enqueue("funnel_events", {
    funnel_name: funnel,
    step_name: step,
    step_index: index,
    metadata: metadata || {},
  });
}

/** Track Python bridge IPC call performance */
export function trackBridgeCall(opts: {
  method: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  paramsSizeBytes?: number;
  responseSizeBytes?: number;
}): void {
  enqueue("bridge_performance", {
    method: opts.method,
    duration_ms: opts.durationMs,
    success: opts.success,
    error_message: opts.errorMessage,
    params_size_bytes: opts.paramsSizeBytes,
    response_size_bytes: opts.responseSizeBytes,
  });
}

/** Track first-time feature discovery */
const discoveredFeatures = new Set<string>();
export function trackFeatureDiscovery(feature: string): void {
  if (discoveredFeatures.has(feature)) return;
  discoveredFeatures.add(feature);
  enqueue("feature_discovery", {
    feature_name: feature,
  });
}

/** Track settings changes */
export function trackSettingsChange(
  setting: string,
  oldValue?: string,
  newValue?: string
): void {
  enqueue("settings_changes", {
    setting_name: setting,
    old_value: oldValue,
    new_value: newValue,
  });
}

// ---------------------------------------------------------------------------
// Session-level engagement counters (flushed at session end)
// ---------------------------------------------------------------------------

const engagement = {
  searchCount: 0,
  downloadStarted: 0,
  downloadCompleted: 0,
  pagesVisited: 0,
  interactionsCount: 0,
  themeToggles: 0,
  exportsCount: 0,
  settingsChanges: 0,
  diagnosticsRun: false,
};

/** Increment an engagement counter */
export function incrementEngagement(key: keyof typeof engagement): void {
  if (typeof engagement[key] === "number") {
    (engagement[key] as number)++;
  } else if (typeof engagement[key] === "boolean") {
    (engagement as Record<string, unknown>)[key] = true;
  }
}

/** Flush engagement summary (called at session end) */
export function flushEngagement(durationSeconds: number): void {
  void deliverImmediate("engagement_summary", [
    {
      session_id: sessionId,
      device_id: getDeviceId(),
      duration_seconds: durationSeconds,
      search_count: engagement.searchCount,
      download_started_count: engagement.downloadStarted,
      download_completed_count: engagement.downloadCompleted,
      pages_visited: engagement.pagesVisited,
      interactions_count: engagement.interactionsCount,
      theme_toggles: engagement.themeToggles,
      exports_count: engagement.exportsCount,
      settings_changes: engagement.settingsChanges,
      diagnostics_run: engagement.diagnosticsRun,
      app_version: getAppVersion(),
    },
  ]);
}

// ---------------------------------------------------------------------------
// First-class capture facts — heatmap + session replay
// (capture modules own buffer/timing; this module owns table + context + delivery)
// ---------------------------------------------------------------------------

export interface ClickHeatmapFact {
  x: number;
  y: number;
  viewport_width: number;
  viewport_height: number;
  element_tag: string;
  element_selector: string;
  element_text: string;
  page_path: string;
}

export interface ScrollDepthFact {
  page_path: string;
  max_depth_percent: number;
  time_at_25_ms: number;
  time_at_50_ms: number;
  time_at_75_ms: number;
  time_at_100_ms: number;
  total_scroll_events: number;
}

export interface MouseTrackingFact {
  page_path: string;
  positions: Array<{ x: number; y: number; t: number }>;
  sample_count: number;
  duration_ms: number;
}

export interface ReplayChunkFact {
  chunk_index: number;
  events: unknown[];
  event_count: number;
  compressed_size_bytes: number;
}

/** Submit click heatmap facts (immediate delivery; identity context). */
export function submitClickHeatmap(facts: ClickHeatmapFact[]): void {
  if (facts.length === 0) return;
  const ctx = identityContext();
  void deliverImmediate(
    "click_heatmap",
    facts.map((f) => ({
      ...ctx,
      x: f.x,
      y: f.y,
      viewport_width: f.viewport_width,
      viewport_height: f.viewport_height,
      element_tag: f.element_tag,
      element_selector: f.element_selector,
      element_text: f.element_text,
      page_path: f.page_path,
    }))
  );
}

/** Submit scroll depth fact (immediate delivery; identity context). */
export function submitScrollDepth(fact: ScrollDepthFact): void {
  void deliverImmediate("scroll_depth", [
    {
      ...identityContext(),
      page_path: fact.page_path,
      max_depth_percent: fact.max_depth_percent,
      time_at_25_ms: fact.time_at_25_ms,
      time_at_50_ms: fact.time_at_50_ms,
      time_at_75_ms: fact.time_at_75_ms,
      time_at_100_ms: fact.time_at_100_ms,
      total_scroll_events: fact.total_scroll_events,
    },
  ]);
}

/** Submit mouse tracking fact (immediate delivery; identity context). */
export function submitMouseTracking(fact: MouseTrackingFact): void {
  void deliverImmediate("mouse_tracking", [
    {
      ...identityContext(),
      page_path: fact.page_path,
      positions: fact.positions,
      sample_count: fact.sample_count,
      duration_ms: fact.duration_ms,
    },
  ]);
}

/** Submit a replay chunk (immediate delivery; identity context). */
export function submitReplayChunk(fact: ReplayChunkFact): void {
  void deliverImmediate("replay_chunks", [
    {
      ...identityContext(),
      chunk_index: fact.chunk_index,
      events: fact.events,
      event_count: fact.event_count,
      compressed_size_bytes: fact.compressed_size_bytes,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Test seams (not for product code)
// ---------------------------------------------------------------------------

/** Inject transport (null restores default fetch-based transport). */
export function __setTelemetryTransportForTests(
  transport: TelemetryTransport | null
): void {
  injectedTransport = transport;
}

/** Override configured check (null restores supabase-config). */
export function __setTelemetryConfiguredForTests(value: boolean | null): void {
  configuredOverride = value;
}

/** Inject timer functions for batch-interval tests (null restores real timers). */
export function __setTelemetryTimersForTests(
  next: TelemetryTimers | null
): void {
  timers = next ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}

/** Drain ordinary queue length (for assertions). */
export function __getOrdinaryQueueLengthForTests(): number {
  return queue.length;
}

/** Reset in-memory telemetry state between tests. */
export function __resetTelemetryStateForTests(): void {
  if (flushTimer) {
    timers.clearTimeout(flushTimer);
    flushTimer = null;
  }
  queue = [];
  injectedTransport = null;
  configuredOverride = null;
  timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  discoveredFeatures.clear();
  engagement.searchCount = 0;
  engagement.downloadStarted = 0;
  engagement.downloadCompleted = 0;
  engagement.pagesVisited = 0;
  engagement.interactionsCount = 0;
  engagement.themeToggles = 0;
  engagement.exportsCount = 0;
  engagement.settingsChanges = 0;
  engagement.diagnosticsRun = false;
  // Keep sessionId stable within a module load; tests that need a fresh
  // session can re-import or call __rotateSessionIdForTests.
}

/** Rotate session id (tests only). */
export function __rotateSessionIdForTests(): string {
  sessionId = generateId();
  return sessionId;
}
