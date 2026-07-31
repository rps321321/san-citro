/**
 * Compact shell route labels (issue #54).
 *
 * Single map for title-bar context chrome. Page routes still own their full
 * `h1` / hierarchy — this is window context only, not a second nav system.
 */

export type RouteMeta = {
  /** Compact title-bar label */
  label: string;
  /** Optional back control (only where nested context is meaningful) */
  showBack?: boolean;
  /** Target for the optional back control */
  backTo?: string;
  /** Accessible name for the back control */
  backLabel?: string;
};

/** Canonical path → shell metadata. Paths match HashRouter location.pathname. */
export const ROUTE_META: Record<string, RouteMeta> = {
  "/search": { label: "Search" },
  "/library": { label: "Library" },
  "/activity": { label: "Activity" },
  "/settings": { label: "Settings" },
  "/reader": {
    label: "Reader",
    showBack: true,
    backTo: "/library",
    backLabel: "Back to Library",
  },
};

const FALLBACK: RouteMeta = { label: "San Citro" };

/** Normalize pathname (trailing slash) then look up shell metadata. */
export function getRouteMeta(pathname: string): RouteMeta {
  if (!pathname || pathname === "/") return ROUTE_META["/search"] ?? FALLBACK;
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return ROUTE_META[path] ?? FALLBACK;
}
