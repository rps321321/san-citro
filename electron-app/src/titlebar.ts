/**
 * Title-bar ↔ Electron titleBarOverlay contract (issue #53).
 *
 * Keep values in lockstep with:
 * - `web/src/lib/titlebar.ts`
 * - CSS tokens `--titlebar-*` in `web/src/app/globals.css`
 *
 * Native caption buttons are OS-owned via titleBarOverlay. Only Close receives
 * Windows' destructive hover treatment; never implement custom window controls.
 *
 * Packaged Windows smoke checklist (manual; not automated in CI):
 * - Light + dark: overlay bg matches header strip (no stale tint patch)
 * - Minimize / maximize / restore: neutral normal + hover (never red)
 * - Close: destructive red hover only
 * - Active press feedback on each caption button
 * - Maximized and restored: all three controls remain clickable
 * - Theme toggle: overlay recolors without a visible wrong-theme patch
 * - No content/drag under the caption strip; status pill stays clear of it
 */

export const TITLEBAR_HEIGHT_PX = 36;

/** Reserved width for the native caption-button strip (3 × ~46px Win11). */
export const TITLEBAR_OVERLAY_WIDTH_PX = 138;

export type TitlebarTheme = 'light' | 'dark';

export type TitlebarOverlayColors = {
  color: string;
  symbolColor: string;
};

export const TITLEBAR_OVERLAY: Record<TitlebarTheme, TitlebarOverlayColors> = {
  light: { color: '#ffffff', symbolColor: '#0a0a0a' },
  dark: { color: '#0a0a0a', symbolColor: '#fafafa' },
};

/** Default theme matches ThemeProvider defaultTheme="dark". */
export const DEFAULT_TITLEBAR_OVERLAY: TitlebarOverlayColors =
  TITLEBAR_OVERLAY.dark;

export function resolveTitlebarOverlay(
  theme: string | undefined
): TitlebarOverlayColors {
  return theme === 'light' ? TITLEBAR_OVERLAY.light : TITLEBAR_OVERLAY.dark;
}
