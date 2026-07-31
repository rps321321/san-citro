/**
 * Title-bar ↔ Electron titleBarOverlay contract (issue #53).
 *
 * Keep values in lockstep with:
 * - `electron-app/src/titlebar.ts`
 * - CSS tokens `--titlebar-*` in `web/src/app/globals.css`
 *
 * Overlay colors are explicit light/dark hex pairs (not DOM body probes).
 * Native caption buttons stay Electron-owned; only Close may show Windows'
 * destructive hover — do not recreate min/max/close in React.
 */

export const TITLEBAR_HEIGHT_PX = 36;

/** Reserved width for the native caption-button strip (3 × ~46px Win11). */
export const TITLEBAR_OVERLAY_WIDTH_PX = 138;

export type TitlebarTheme = "light" | "dark";

export type TitlebarOverlayColors = {
  color: string;
  symbolColor: string;
};

/**
 * Opaque title-bar fill + glyph colors matching ADR-0016 background/foreground
 * (oklch(1 0 0) / oklch(0.145 0 0) and dark invert).
 */
export const TITLEBAR_OVERLAY: Record<TitlebarTheme, TitlebarOverlayColors> = {
  light: { color: "#ffffff", symbolColor: "#0a0a0a" },
  dark: { color: "#0a0a0a", symbolColor: "#fafafa" },
};

/** Map next-themes resolved value (or undefined during hydrate) to overlay colors. */
export function resolveTitlebarOverlay(
  theme: string | undefined
): TitlebarOverlayColors {
  return theme === "light" ? TITLEBAR_OVERLAY.light : TITLEBAR_OVERLAY.dark;
}
