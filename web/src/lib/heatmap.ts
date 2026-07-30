"use client";

/**
 * Heatmap analytics — tracks click positions, scroll depth, and mouse movement.
 *
 * Capture + buffer policy live here. Table mapping, telemetry context, and
 * delivery are owned by the telemetry deep module (submitClickHeatmap /
 * submitScrollDepth / submitMouseTracking).
 *
 * Buffers:
 * - click_heatmap: flush every 15s (or on stop/unload)
 * - mouse_tracking: sample every 200ms, flush every 15s
 * - scroll_depth: idle timeout 60s / stop / unload
 *
 * Errors are silently caught — this module must never break the app.
 */

import {
  submitClickHeatmap,
  submitScrollDepth,
  submitMouseTracking,
} from "./telemetry";

const CLICK_FLUSH_INTERVAL_MS = 15_000;
const MOUSE_FLUSH_INTERVAL_MS = 15_000;
const MOUSE_SAMPLE_INTERVAL_MS = 200;
const SCROLL_IDLE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClickRecord {
  x: number;
  y: number;
  viewport_width: number;
  viewport_height: number;
  element_tag: string;
  element_selector: string;
  element_text: string;
}

interface MouseSample {
  x: number;
  y: number;
  t: number;
}

interface QuartileTimes {
  q25: number;
  q50: number;
  q75: number;
  q100: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isTracking = false;

// Click heatmap state
let clickBuffer: ClickRecord[] = [];
let clickFlushTimer: ReturnType<typeof setInterval> | null = null;

// Mouse movement state
let mouseBuffer: MouseSample[] = [];
let mouseFlushTimer: ReturnType<typeof setInterval> | null = null;
let mouseSampleTimer: ReturnType<typeof setInterval> | null = null;
let lastMouseX = 0;
let lastMouseY = 0;
let mouseTrackingStartTime = 0;

// Scroll depth state
let maxScrollPercent = 0;
let quartileTimes: QuartileTimes = { q25: 0, q50: 0, q75: 0, q100: 0 };
let lastQuartileCheckTime = 0;
let currentQuartile = 0;
let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
let scrollFlushed = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pagePath(): string {
  return typeof window !== "undefined" ? window.location.pathname : "";
}

function getSelector(el: Element): string {
  try {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;

    const classes = Array.from(el.classList).join(".");
    if (classes) return `${tag}.${classes}`;

    // Fall back to nth-child
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(el) + 1;
      return `${tag}:nth-child(${index})`;
    }

    return tag;
  } catch {
    return "unknown";
  }
}

function getScrollPercent(): number {
  const docHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );
  const viewportHeight = window.innerHeight;
  const scrollTop =
    window.scrollY || document.documentElement.scrollTop || 0;

  if (docHeight <= viewportHeight) return 100;
  return Math.min(
    100,
    Math.round(((scrollTop + viewportHeight) / docHeight) * 100)
  );
}

function getQuartileIndex(percent: number): number {
  if (percent >= 100) return 4;
  if (percent >= 75) return 3;
  if (percent >= 50) return 2;
  if (percent >= 25) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Click heatmap
// ---------------------------------------------------------------------------

function handleClick(event: MouseEvent): void {
  try {
    const target = event.target as Element | null;
    if (!target) return;

    clickBuffer.push({
      x: event.clientX,
      y: event.clientY,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      element_tag: target.tagName?.toLowerCase() || "unknown",
      element_selector: getSelector(target),
      element_text: (target.textContent || "").trim().slice(0, 50),
    });
  } catch {
    // Silently ignore
  }
}

function flushClicks(): void {
  if (clickBuffer.length === 0) return;

  const path = pagePath();
  const facts = clickBuffer.map((click) => ({
    ...click,
    page_path: path,
  }));
  clickBuffer = [];
  try {
    submitClickHeatmap(facts);
  } catch {
    // Never break the app
  }
}

// ---------------------------------------------------------------------------
// Scroll depth
// ---------------------------------------------------------------------------

function updateQuartileTime(): void {
  const now = Date.now();
  if (lastQuartileCheckTime > 0 && currentQuartile > 0) {
    const elapsed = now - lastQuartileCheckTime;
    // Only accumulate time at the EXACT quartile the user is currently at
    if (currentQuartile === 1) quartileTimes.q25 += elapsed;
    else if (currentQuartile === 2) quartileTimes.q50 += elapsed;
    else if (currentQuartile === 3) quartileTimes.q75 += elapsed;
    else if (currentQuartile === 4) quartileTimes.q100 += elapsed;
  }
  lastQuartileCheckTime = now;
}

function handleScroll(): void {
  try {
    const percent = getScrollPercent();
    if (percent > maxScrollPercent) {
      maxScrollPercent = percent;
    }

    // Update time tracking for previous quartile before switching
    updateQuartileTime();
    currentQuartile = getQuartileIndex(percent);

    // Reset idle timer
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(flushScrollDepth, SCROLL_IDLE_TIMEOUT_MS);
  } catch {
    // Silently ignore
  }
}

function flushScrollDepth(): void {
  if (scrollFlushed) return;
  scrollFlushed = true;

  // Capture final quartile time
  updateQuartileTime();

  try {
    submitScrollDepth({
      page_path: pagePath(),
      max_depth_percent: maxScrollPercent,
      time_at_25_ms: Math.round(quartileTimes.q25),
      time_at_50_ms: Math.round(quartileTimes.q50),
      time_at_75_ms: Math.round(quartileTimes.q75),
      time_at_100_ms: Math.round(quartileTimes.q100),
      total_scroll_events: 0,
    });
  } catch {
    // Never break the app
  }
}

// ---------------------------------------------------------------------------
// Mouse movement
// ---------------------------------------------------------------------------

function handleMouseMove(event: MouseEvent): void {
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
}

function sampleMousePosition(): void {
  try {
    mouseBuffer.push({
      x: lastMouseX,
      y: lastMouseY,
      t: Date.now() - mouseTrackingStartTime,
    });
  } catch {
    // Silently ignore
  }
}

function flushMouseMovement(): void {
  if (mouseBuffer.length === 0) return;

  const samples = [...mouseBuffer];
  mouseBuffer = [];

  const durationMs =
    samples.length > 1
      ? samples[samples.length - 1].t - samples[0].t
      : 0;

  try {
    submitMouseTracking({
      page_path: pagePath(),
      positions: samples,
      sample_count: samples.length,
      duration_ms: durationMs,
    });
  } catch {
    // Never break the app
  }
}

// ---------------------------------------------------------------------------
// Page unload handler
// ---------------------------------------------------------------------------

function handleBeforeUnload(): void {
  try {
    flushClicks();
    flushMouseMovement();
    if (!scrollFlushed) flushScrollDepth();
  } catch {
    // Silently ignore
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startHeatmapTracking(): void {
  if (typeof window === "undefined" || isTracking) return;

  try {
    isTracking = true;
    scrollFlushed = false;
    maxScrollPercent = getScrollPercent();
    currentQuartile = getQuartileIndex(maxScrollPercent);
    lastQuartileCheckTime = Date.now();
    quartileTimes = { q25: 0, q50: 0, q75: 0, q100: 0 };
    mouseTrackingStartTime = Date.now();

    // Click tracking
    document.addEventListener("click", handleClick, { capture: true });
    clickFlushTimer = setInterval(flushClicks, CLICK_FLUSH_INTERVAL_MS);

    // Scroll tracking
    window.addEventListener("scroll", handleScroll, { passive: true });
    scrollIdleTimer = setTimeout(flushScrollDepth, SCROLL_IDLE_TIMEOUT_MS);

    // Mouse movement tracking
    document.addEventListener("mousemove", handleMouseMove, {
      passive: true,
    });
    mouseSampleTimer = setInterval(
      sampleMousePosition,
      MOUSE_SAMPLE_INTERVAL_MS
    );
    mouseFlushTimer = setInterval(
      flushMouseMovement,
      MOUSE_FLUSH_INTERVAL_MS
    );

    // Unload handler
    window.addEventListener("beforeunload", handleBeforeUnload);
  } catch {
    // Silently ignore — never break the app
  }
}

export function stopHeatmapTracking(): void {
  if (typeof window === "undefined" || !isTracking) return;

  try {
    isTracking = false;

    // Remove click tracking
    document.removeEventListener("click", handleClick, { capture: true });
    if (clickFlushTimer) {
      clearInterval(clickFlushTimer);
      clickFlushTimer = null;
    }
    flushClicks();

    // Remove scroll tracking
    window.removeEventListener("scroll", handleScroll);
    if (scrollIdleTimer) {
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = null;
    }
    if (!scrollFlushed) flushScrollDepth();

    // Remove mouse tracking
    document.removeEventListener("mousemove", handleMouseMove);
    if (mouseSampleTimer) {
      clearInterval(mouseSampleTimer);
      mouseSampleTimer = null;
    }
    if (mouseFlushTimer) {
      clearInterval(mouseFlushTimer);
      mouseFlushTimer = null;
    }
    flushMouseMovement();

    // Remove unload handler
    window.removeEventListener("beforeunload", handleBeforeUnload);
  } catch {
    // Silently ignore
  }
}
