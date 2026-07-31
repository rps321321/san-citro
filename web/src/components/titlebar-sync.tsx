"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

import { setTitlebarOverlay } from "@/lib/api-client";
import { resolveTitlebarOverlay } from "@/lib/titlebar";

/**
 * Syncs Electron's native titleBarOverlay colors to explicit light/dark
 * title-bar tokens (issue #53). Renders nothing. Does not implement window
 * controls — minimize/maximize/close stay OS-owned; only Close may receive
 * Windows' destructive hover treatment.
 */
export function TitlebarSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    // Wait for next-themes to resolve so we do not flash the wrong overlay.
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;

    try {
      setTitlebarOverlay(resolveTitlebarOverlay(resolvedTheme));
    } catch {
      /* bridge not ready / not in the desktop app */
    }
  }, [resolvedTheme]);

  return null;
}
