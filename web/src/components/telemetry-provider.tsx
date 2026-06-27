"use client";

import { useEffect, useRef } from "react";
import {
  startSession,
  endSession,
  trackPageView,
  trackError,
  flushTelemetry,
  flushEngagement,
} from "@/lib/telemetry";
import { startRecording, stopRecording } from "@/lib/session-recorder";
import { startHeatmapTracking, stopHeatmapTracking } from "@/lib/heatmap";
import { startFrustrationDetection, stopFrustrationDetection } from "@/lib/frustration";

/**
 * Telemetry provider — initializes ALL tracking systems:
 * - Session lifecycle (start/end/duration)
 * - Page views
 * - Global error capture
 * - rrweb session replay recording
 * - Click heatmaps + scroll depth + mouse tracking
 * - Frustration signal detection (rage clicks, dead clicks, etc.)
 * - Engagement summary flush on session end
 *
 * Mount once in the root layout.
 */
export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const startTime = useRef(0);

  useEffect(() => {
    // Stamp the mount time here (not during render — Date.now() is impure).
    startTime.current = Date.now();

    // 1. Start session + basic telemetry
    startSession();
    trackPageView(window.location.pathname);

    // 2. Start rrweb session replay recording
    try {
      startRecording();
    } catch {
      // rrweb may fail in some environments — don't break the app
    }

    // 3. Start heatmap tracking (clicks, scroll, mouse)
    try {
      startHeatmapTracking();
    } catch {
      // Never break the app
    }

    // 4. Start frustration detection (rage clicks, dead clicks, etc.)
    try {
      startFrustrationDetection();
    } catch {
      // Never break the app
    }

    // 5. Global error handlers
    const handleError = (event: ErrorEvent) => {
      trackError("unhandled_error", event.message, {
        stack: event.error?.stack,
        component: "window",
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      const message = event.reason instanceof Error
        ? event.reason.message
        : String(event.reason);
      trackError("unhandled_rejection", message, {
        stack: event.reason?.stack,
        component: "promise",
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    // 6. End everything on unload
    const handleUnload = () => {
      const duration = Math.round((Date.now() - startTime.current) / 1000);
      stopRecording();
      stopHeatmapTracking();
      stopFrustrationDetection();
      flushEngagement(duration);
      endSession(duration);
      flushTelemetry();
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
      window.removeEventListener("beforeunload", handleUnload);
      stopRecording();
      stopHeatmapTracking();
      stopFrustrationDetection();
    };
  }, []);

  return <>{children}</>;
}
