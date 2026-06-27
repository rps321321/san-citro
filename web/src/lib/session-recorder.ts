"use client";

/**
 * Session recorder — captures DOM replay events via rrweb and uploads
 * compressed chunks to the `replay_chunks` table in Supabase.
 *
 * Recording is privacy-conscious: all input values are masked and mouse
 * movement is disabled (handled by a separate tracker). Errors are
 * silently caught so recording never breaks the app.
 */

import { record } from "rrweb";
import { getDeviceId, getSessionId } from "./telemetry";

// rrweb v2 alpha — typed as its documented event shape
interface RRWebEvent {
  type: number;
  data: Record<string, unknown>;
  timestamp: number;
  delay?: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from "./supabase-config";

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFER_SIZE = 100;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let eventBuffer: RRWebEvent[] = [];
let chunkIndex = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let stopFn: (() => void) | null = null;
let isRecording = false;

// ---------------------------------------------------------------------------
// Flush logic
// ---------------------------------------------------------------------------

async function sendChunk(events: RRWebEvent[]): Promise<void> {
  if (events.length === 0) return;
  if (!isSupabaseConfigured()) return;

  const payload = JSON.stringify(events);
  const compressedSizeBytes = new Blob([payload]).size;
  const currentChunkIndex = chunkIndex++;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/replay_chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify([
        {
          session_id: getSessionId(),
          device_id: getDeviceId(),
          chunk_index: currentChunkIndex,
          events,
          event_count: events.length,
          compressed_size_bytes: compressedSizeBytes,
        },
      ]),
    });

    if (!res.ok) {
      console.debug(
        `[session-recorder] Failed to send chunk ${currentChunkIndex}: ${res.status}`
      );
    }
  } catch {
    // Silently drop — recording should never break the app
    console.debug("[session-recorder] Network error sending chunk");
  }
}

function flushBuffer(): void {
  if (eventBuffer.length === 0) return;

  const events = eventBuffer;
  eventBuffer = [];
  sendChunk(events);
}

// ---------------------------------------------------------------------------
// beforeunload handler
// ---------------------------------------------------------------------------

function handleBeforeUnload(): void {
  flushBuffer();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start recording the user's session with rrweb.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startRecording(): void {
  if (isRecording || typeof window === "undefined") return;

  try {
    stopFn = record({
      emit(event: RRWebEvent) {
        try {
          eventBuffer.push(event);

          if (eventBuffer.length >= MAX_BUFFER_SIZE) {
            flushBuffer();
          }
        } catch {
          // Never let event handling break the app
        }
      },
      maskAllInputs: true,
      sampling: {
        mousemove: false,
        scroll: 150,
      },
    }) ?? null;

    isRecording = true;

    // Periodic flush
    flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);

    // Flush on page unload
    window.addEventListener("beforeunload", handleBeforeUnload);
  } catch {
    // If rrweb fails to initialize, silently bail
    console.debug("[session-recorder] Failed to start recording");
  }
}

/**
 * Stop recording and flush any remaining events.
 */
export function stopRecording(): void {
  if (!isRecording) return;

  try {
    // Stop rrweb
    if (stopFn) {
      stopFn();
      stopFn = null;
    }

    // Clear periodic flush
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }

    // Remove unload listener
    window.removeEventListener("beforeunload", handleBeforeUnload);

    // Flush remaining events
    flushBuffer();

    isRecording = false;
  } catch {
    // Ensure state is reset even if cleanup fails
    isRecording = false;
    stopFn = null;
    flushTimer = null;
  }
}
