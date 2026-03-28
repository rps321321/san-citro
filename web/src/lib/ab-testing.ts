"use client";

/**
 * Simple A/B testing framework — deterministic variant assignment
 * based on device_id, with conversion tracking via Supabase.
 */

import { getDeviceId, getSessionId } from "./telemetry";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = "https://baoxanfqzxpdevjbysjc.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhb3hhbmZxenhwZGV2amJ5c2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NjYwMzksImV4cCI6MjA5MDI0MjAzOX0.LwOtCekQ3hNHH9rS-otFg6Tymh6H-tXhBZXtc5c1dGQ";

const STORAGE_KEY = "san-citro:ab-assignments";

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0; // Convert to 32-bit int
  }
  return Math.abs(hash);
}

// ---------------------------------------------------------------------------
// localStorage cache
// ---------------------------------------------------------------------------

function loadAssignments(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAssignments(assignments: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(assignments));
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

// ---------------------------------------------------------------------------
// Track which experiments have been recorded this session
// ---------------------------------------------------------------------------

const recordedThisSession = new Set<string>();

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch {
    // Silently drop — A/B tracking should never break the app.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the variant for an experiment. Deterministic: same device always gets
 * the same variant. Records assignment in Supabase on first call per
 * experiment per session.
 */
export function getVariant(experimentName: string, variants: string[]): string {
  if (!variants.length) return "";

  try {
    const deviceId = getDeviceId();
    const assignments = loadAssignments();

    // Check if already assigned
    if (assignments[experimentName] && variants.includes(assignments[experimentName])) {
      const variant = assignments[experimentName];

      // Record to Supabase once per session
      if (!recordedThisSession.has(experimentName)) {
        recordedThisSession.add(experimentName);
        insertRow("ab_experiments", {
          device_id: deviceId,
          session_id: getSessionId(),
          experiment_name: experimentName,
          variant,
        });
      }

      return variant;
    }

    // Assign deterministically based on hash
    const hash = hashString(`${deviceId}:${experimentName}`);
    const index = hash % variants.length;
    const variant = variants[index];

    // Persist to localStorage
    assignments[experimentName] = variant;
    saveAssignments(assignments);

    // Record to Supabase
    recordedThisSession.add(experimentName);
    insertRow("ab_experiments", {
      device_id: deviceId,
      session_id: getSessionId(),
      experiment_name: experimentName,
      variant,
    });

    return variant;
  } catch {
    // Fallback: return first variant
    return variants[0];
  }
}

/**
 * Track a conversion event for an experiment. Looks up the assigned variant
 * and records it alongside the conversion event.
 */
export function trackConversion(
  experimentName: string,
  conversionEvent: string,
  metadata?: Record<string, unknown>
): void {
  try {
    const deviceId = getDeviceId();
    const assignments = loadAssignments();
    const variant = assignments[experimentName];

    if (!variant) return; // No assignment — nothing to track

    insertRow("ab_conversions", {
      device_id: deviceId,
      session_id: getSessionId(),
      experiment_name: experimentName,
      variant,
      conversion_event: conversionEvent,
      metadata: metadata || {},
    });
  } catch {
    // Silently drop.
  }
}
