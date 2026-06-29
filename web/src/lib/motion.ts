import type { Transition } from "motion/react";

// Apple-like spring presets for the redesign (ADR-0011). Use these instead of
// generic linear tweens so motion feels physical, not mechanical. Pick by surface
// size: gentle for large surfaces/sheets, smooth for default state changes, snappy
// for small controls (toggles, buttons).
export const springGentle: Transition = { type: "spring", stiffness: 170, damping: 26 };
export const springSmooth: Transition = { type: "spring", stiffness: 260, damping: 30 };
export const springSnappy: Transition = { type: "spring", stiffness: 420, damping: 34 };

// Apple-ish ease + durations for non-spring transitions (opacity, color).
export const easeApple = [0.16, 1, 0.3, 1] as const;
export const durationFast = 0.18;
export const durationBase = 0.26;
