"use client";

/**
 * Frustration signal detection — identifies rage clicks, dead clicks,
 * rapid retries, and error-then-action patterns, then sends them to Supabase.
 */

import { getDeviceId, getSessionId } from "./telemetry";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from "./supabase-config";

const RAGE_CLICK_THRESHOLD = 3;
const RAGE_CLICK_WINDOW_MS = 1_000;
const RAPID_RETRY_WINDOW_MS = 5_000;
const DEDUP_INTERVAL_MS = 10_000;

const INTERACTIVE_SELECTORS = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[role=\"button\"]",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SignalType = "rage_click" | "dead_click" | "rapid_retry" | "error_then_action";

interface ClickRecord {
  timestamp: number;
  selector: string;
  targetText: string;
  isInteractive: boolean;
}

interface SentSignal {
  type: SignalType;
  selector: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let clickHistory: ClickRecord[] = [];
let sentSignals: SentSignal[] = [];
let clickHandler: ((e: MouseEvent) => void) | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 3).join(".");
  const parent = el.parentElement;
  const parentTag = parent ? parent.tagName.toLowerCase() : "";
  return classes ? `${parentTag} > ${tag}.${classes}` : `${parentTag} > ${tag}`;
}

function getTargetText(el: Element): string {
  const text = (el.textContent || "").trim();
  return text.slice(0, 120);
}

function isInteractiveElement(el: Element): boolean {
  return INTERACTIVE_SELECTORS.some((sel) => el.matches(sel));
}

function isErrorVisible(): boolean {
  // Check for common error alert patterns in the DOM
  const errorSelectors = [
    "[role=\"alert\"]",
    ".error",
    ".alert-error",
    ".toast-error",
    "[data-error]",
    ".notification-error",
  ];
  return errorSelectors.some((sel) => document.querySelector(sel) !== null);
}

function isDuplicate(type: SignalType, selector: string): boolean {
  const now = Date.now();
  // Prune old entries
  sentSignals = sentSignals.filter((s) => now - s.timestamp < DEDUP_INTERVAL_MS);
  return sentSignals.some((s) => s.type === type && s.selector === selector);
}

function markSent(type: SignalType, selector: string): void {
  sentSignals.push({ type, selector, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Supabase sender
// ---------------------------------------------------------------------------

async function sendSignal(
  signalType: SignalType,
  selector: string,
  targetText: string,
  clickCount: number,
  timeWindowMs: number
): Promise<void> {
  if (!isSupabaseConfigured()) return;
  if (isDuplicate(signalType, selector)) return;
  markSent(signalType, selector);

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/frustration_signals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        device_id: getDeviceId(),
        session_id: getSessionId(),
        signal_type: signalType,
        page_path: window.location.pathname,
        target_selector: selector,
        target_text: targetText,
        click_count: clickCount,
        time_window_ms: timeWindowMs,
      }),
    });
  } catch {
    // Silently drop — frustration detection should never break the app.
  }
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

function detectRageClicks(selector: string, targetText: string): void {
  const now = Date.now();
  const recentSameTarget = clickHistory.filter(
    (c) => c.selector === selector && now - c.timestamp <= RAGE_CLICK_WINDOW_MS
  );

  if (recentSameTarget.length >= RAGE_CLICK_THRESHOLD) {
    const windowMs = now - recentSameTarget[0].timestamp;
    sendSignal("rage_click", selector, targetText, recentSameTarget.length, windowMs);
  }
}

function detectDeadClick(el: Element, selector: string, targetText: string): void {
  // Only flag dead clicks on elements that visually appear interactive (have pointer cursor)
  // to avoid false positives on normal text selection clicks
  if (!isInteractiveElement(el)) {
    const cursor = window.getComputedStyle(el).cursor;
    if (cursor === "pointer") {
      sendSignal("dead_click", selector, targetText, 1, 0);
    }
  }
}

function detectRapidRetry(selector: string, targetText: string): void {
  const now = Date.now();
  const recentSameAction = clickHistory.filter(
    (c) => c.selector === selector && now - c.timestamp <= RAPID_RETRY_WINDOW_MS
  );

  // Rapid retry is 2+ occurrences within the window (current click not yet in history)
  if (recentSameAction.length >= 2) {
    const windowMs = now - recentSameAction[0].timestamp;
    sendSignal("rapid_retry", selector, targetText, recentSameAction.length, windowMs);
  }
}

function detectErrorThenAction(selector: string, targetText: string): void {
  if (isErrorVisible()) {
    sendSignal("error_then_action", selector, targetText, 1, 0);
  }
}

// ---------------------------------------------------------------------------
// Click handler
// ---------------------------------------------------------------------------

function handleClick(e: MouseEvent): void {
  const target = e.target as Element | null;
  if (!target) return;

  const selector = getSelector(target);
  const targetText = getTargetText(target);
  const now = Date.now();

  // Run detections before adding current click to history
  detectRageClicks(selector, targetText);
  detectDeadClick(target, selector, targetText);
  detectRapidRetry(selector, targetText);
  detectErrorThenAction(selector, targetText);

  // Record the click
  clickHistory.push({
    timestamp: now,
    selector,
    targetText,
    isInteractive: isInteractiveElement(target),
  });

  // Prune old clicks (keep last 30 seconds)
  clickHistory = clickHistory.filter((c) => now - c.timestamp < 30_000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startFrustrationDetection(): void {
  if (typeof window === "undefined" || clickHandler) return;

  clickHandler = handleClick;
  document.addEventListener("click", clickHandler, { capture: true });
}

export function stopFrustrationDetection(): void {
  if (typeof window === "undefined" || !clickHandler) return;

  document.removeEventListener("click", clickHandler, { capture: true });
  clickHandler = null;
  clickHistory = [];
  sentSignals = [];
}
