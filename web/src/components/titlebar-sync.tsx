"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

import { setTitlebarOverlay } from "@/lib/api-client";

/** Convert a computed `rgb(r, g, b)` string to `#rrggbb` (Electron's overlay
 * color wants a hex/rgb string; hex is the safest). Falls back to the input. */
function rgbToHex(value: string): string {
  const parts = value.match(/\d+/g);
  if (!parts || parts.length < 3) return value;
  return (
    "#" +
    parts
      .slice(0, 3)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Recolors the OS window-controls overlay to match the title-bar background
 * (the sidebar color) for the active theme, so the control area blends into the
 * title bar instead of showing a fixed dark patch. Renders nothing.
 */
export function TitlebarSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    // Read the actual rendered sidebar colors via a hidden probe (resolves CSS
    // variables to concrete rgb regardless of the color space used in CSS).
    const probe = document.createElement("div");
    probe.className = "bg-sidebar text-sidebar-foreground";
    probe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const color = rgbToHex(cs.backgroundColor);
    const symbolColor = rgbToHex(cs.color);
    document.body.removeChild(probe);

    try {
      setTitlebarOverlay({ color, symbolColor });
    } catch {
      /* bridge not ready / not in the desktop app */
    }
  }, [resolvedTheme]);

  return null;
}
