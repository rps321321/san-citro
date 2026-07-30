"use client";

/**
 * Simple A/B testing framework — deterministic variant assignment
 * based on device_id, with conversion tracking via typed telemetry facts.
 *
 * Assignment + local cache live here. Table mapping, telemetry context, and
 * delivery are owned by the telemetry deep module
 * (submitExperimentAssignment / submitExperimentConversion).
 */

import {
  getDeviceId,
  submitExperimentAssignment,
  submitExperimentConversion,
} from "./telemetry";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the variant for an experiment. Deterministic: same device always gets
 * the same variant. Records assignment via telemetry on first call per
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

      // Record once per session
      if (!recordedThisSession.has(experimentName)) {
        recordedThisSession.add(experimentName);
        submitExperimentAssignment({
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

    // Record assignment
    recordedThisSession.add(experimentName);
    submitExperimentAssignment({
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
    const assignments = loadAssignments();
    const variant = assignments[experimentName];

    if (!variant) return; // No assignment — nothing to track

    submitExperimentConversion({
      experiment_name: experimentName,
      variant,
      conversion_event: conversionEvent,
      metadata: metadata || {},
    });
  } catch {
    // Silently drop.
  }
}
