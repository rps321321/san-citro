"use client";

/**
 * Telemetry client for San Citro — sends analytics to Supabase.
 *
 * Data collected:
 * - Usage events (searches, downloads, page views, UI interactions)
 * - Performance metrics (latencies, speeds, timings)
 * - Errors (crashes, IPC failures, network errors)
 * - System info (hardware, OS, screen, versions)
 * - Session tracking (start/end, duration, daily activity)
 *
 * All data is keyed by a persistent device_id (UUID in localStorage)
 * and a per-session session_id. The Supabase anon key only allows
 * inserts — the data is write-only from the app's perspective.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from "./supabase-config";

const DEVICE_ID_KEY = "san-citro:device-id";
const BATCH_INTERVAL_MS = 30_000; // Flush events every 30s
const MAX_BATCH_SIZE = 50;

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
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

const sessionId = generateId();

// ---------------------------------------------------------------------------
// Batched sender
// ---------------------------------------------------------------------------

interface QueuedInsert {
  table: string;
  row: Record<string, unknown>;
}

let queue: QueuedInsert[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getAppVersion(): string {
  if (typeof window === "undefined") return "unknown";
  // Read version from Electron's preload-injected API, fall back gracefully
  const api = window.sanCitro;
  if (api && "appVersion" in api) {
    return (api as unknown as { appVersion: string }).appVersion;
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

async function sendToSupabase(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[telemetry] Failed to send to ${table}: ${res.status} ${body}`);
    }
  } catch (err) {
    // Network failure — silently drop. Telemetry should never break the app.
    console.debug("[telemetry] Network error:", err);
  }
}

function flush(): void {
  if (queue.length === 0) return;

  // Group by table
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const item of queue) {
    const existing = grouped.get(item.table) || [];
    existing.push(item.row);
    grouped.set(item.table, existing);
  }
  queue = [];

  // Send each table's batch
  for (const [table, rows] of grouped) {
    sendToSupabase(table, rows);
  }
}

function enqueue(table: string, row: Record<string, unknown>): void {
  const enriched = {
    session_id: sessionId,
    device_id: getDeviceId(),
    app_version: getAppVersion(),
    ...row,
  };
  queue.push({ table, row: enriched });

  if (queue.length >= MAX_BATCH_SIZE) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, BATCH_INTERVAL_MS);
  }
}

// Flush on page unload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
  });
}

// ---------------------------------------------------------------------------
// Public API
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
  sendToSupabase("sessions", [
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

/** Force flush all queued events */
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
  sendToSupabase("engagement_summary", [
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
