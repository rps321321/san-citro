import type { Transition } from "motion/react";

// Desktop-utility motion presets (ADR-0016). Use only for product-meaningful state
// changes (enter/exit of status, sheets, toggles) — not decorative flourish.
// Pick by surface size: gentle for large surfaces/sheets, smooth for default state
// changes, snappy for small controls (toggles, buttons).
export const springGentle: Transition = { type: "spring", stiffness: 170, damping: 26 };
export const springSmooth: Transition = { type: "spring", stiffness: 260, damping: 30 };
export const springSnappy: Transition = { type: "spring", stiffness: 420, damping: 34 };

// Ease-out curve + durations for non-spring transitions (opacity, color).
export const easeOut = [0.16, 1, 0.3, 1] as const;
/** @deprecated Prefer easeOut (ADR-0016 renames easeApple). */
export const easeApple = easeOut;
export const durationFast = 0.18;
export const durationBase = 0.26;

/** Instant transition when the user prefers reduced motion. */
export function transitionOrReduce(
  transition: Transition,
  prefersReducedMotion: boolean | null,
): Transition {
  if (prefersReducedMotion) return { duration: 0 };
  return transition;
}
