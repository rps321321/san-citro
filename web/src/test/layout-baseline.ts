/**
 * Structural layout baselines + inspectable failure artifacts (issue #64).
 *
 * Pixel screenshots are unreliable in jsdom and for native title-bar hover.
 * We gate composition via fingerprints (markers, states, contracts) and write
 * JSON artifacts under web/test-artifacts/desktop-layout/ when comparisons fail.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAYOUT_BASELINE_TOLERANCE,
  TITLEBAR_CONTRACT,
  maskDynamicText,
  type DesktopViewportName,
} from "@/test/desktop-fixtures";

const ARTIFACTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test-artifacts",
  "desktop-layout",
);

export type ShellLayoutFingerprint = {
  scenario: string;
  viewport: DesktopViewportName;
  viewportPx: { width: number; height: number };
  theme: "light" | "dark";
  sidebar: "expanded" | "collapsed" | "unknown";
  searchState: "empty" | "results" | "unknown";
  statusIslandVisible: boolean;
  statusIslandLabel: string | null;
  hasTitlebar: boolean;
  hasOverlaySafeArea: boolean;
  overlaySafeAreaWidth: string | null;
  hasTitlebarCommand: boolean;
  commandInsideSafeArea: boolean;
  hasSearchForm: boolean;
  hasSearchQuery: boolean;
  hasSearchSubmit: boolean;
  hasPageContainerWide: boolean;
  hasEmptyRegion: boolean;
  hasResultsTable: boolean;
  resultRowCount: number;
  customWindowControls: boolean;
  titlebarHeightClass: boolean;
  reducedMotionPreferred: boolean;
  tolerance: typeof LAYOUT_BASELINE_TOLERANCE;
};

export type CaptureOptions = {
  scenario: string;
  viewport: DesktopViewportName;
  viewportPx: { width: number; height: number };
  theme: "light" | "dark";
  container: HTMLElement;
};

function present(root: ParentNode, selector: string): boolean {
  return root.querySelector(selector) !== null;
}

/**
 * Build a stable structural fingerprint of the desktop shell for baseline compare.
 */
export function captureShellLayoutFingerprint(
  opts: CaptureOptions,
): ShellLayoutFingerprint {
  const { container } = opts;
  const sidebarRoot = container.querySelector('[data-slot="sidebar"]');
  const sidebarState = sidebarRoot?.getAttribute("data-state");
  const sidebar: ShellLayoutFingerprint["sidebar"] =
    sidebarState === "expanded" || sidebarState === "collapsed"
      ? sidebarState
      : "unknown";

  const hasEmptyRegion = present(container, "[data-search-empty-region]");
  const hasResultsTable = present(container, "[data-search-results-table]");
  const searchState: ShellLayoutFingerprint["searchState"] = hasResultsTable
    ? "results"
    : hasEmptyRegion
      ? "empty"
      : "unknown";

  const islandBtn = container.querySelector(
    '[aria-label="Downloading…"], [aria-label^="Downloading "], [aria-label="Processing…"], [aria-label^="Processing "], [aria-label="Ready"]',
  ) as HTMLElement | null;

  const safeArea = container.querySelector(
    "[data-titlebar-overlay-safe-area]",
  ) as HTMLElement | null;
  const command = container.querySelector("[data-titlebar-command]");
  const commandInsideSafeArea = !!(
    command &&
    safeArea &&
    safeArea.contains(command)
  );

  const titlebar = container.querySelector("[data-titlebar]") as HTMLElement | null;
  const titlebarHeightClass = !!(
    titlebar?.className.includes("h-[var(--titlebar-height)]") ||
    titlebar?.className.includes(`h-[${TITLEBAR_CONTRACT.heightPx}px]`)
  );

  const customWindowControls = !!(
    container.querySelector(
      'button[aria-label*="minimize" i], button[aria-label*="maximize" i], button[aria-label*="close" i], button[aria-label*="restore" i]',
    ) ||
    container.querySelector(
      '[data-window-control], [data-testid="window-minimize"], [data-testid="window-close"]',
    )
  );

  let reducedMotionPreferred = false;
  try {
    reducedMotionPreferred = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  } catch {
    reducedMotionPreferred = false;
  }

  return {
    scenario: opts.scenario,
    viewport: opts.viewport,
    viewportPx: opts.viewportPx,
    theme: opts.theme,
    sidebar,
    searchState,
    statusIslandVisible: !!islandBtn,
    statusIslandLabel: islandBtn?.getAttribute("aria-label") ?? null,
    hasTitlebar: present(container, "[data-titlebar]"),
    hasOverlaySafeArea: !!safeArea,
    overlaySafeAreaWidth: safeArea?.style.width || null,
    hasTitlebarCommand: !!command,
    commandInsideSafeArea,
    hasSearchForm: !!container.querySelector('form[aria-label="Search controls"]'),
    hasSearchQuery: !!container.querySelector('[aria-label="Search query"]'),
    hasSearchSubmit: !!container.querySelector(
      'button[data-search-submit], button[type="submit"]',
    ),
    hasPageContainerWide: present(container, '[data-page-container="wide"]'),
    hasEmptyRegion,
    hasResultsTable,
    resultRowCount: container.querySelectorAll("[data-search-result-row]").length,
    customWindowControls,
    titlebarHeightClass,
    reducedMotionPreferred,
    tolerance: LAYOUT_BASELINE_TOLERANCE,
  };
}

/** Compact structural dump of chrome markers (masked for dynamic values). */
export function captureShellStructureDump(container: HTMLElement): string {
  const markers = [
    "data-titlebar",
    "data-titlebar-route",
    "data-titlebar-command",
    "data-titlebar-overlay-safe-area",
    "data-slot=sidebar",
    "data-slot=sidebar-inner",
    "data-search-empty-region",
    "data-search-results-table",
    "data-search-result-row",
    "data-page-container",
    "data-search-filters",
  ];

  const lines: string[] = [];
  for (const m of markers) {
    const sel = m.includes("=") ? `[${m}]` : `[${m}]`;
    const nodes = container.querySelectorAll(sel);
    lines.push(`${m}: count=${nodes.length}`);
    nodes.forEach((node, i) => {
      if (i > 4) return;
      const el = node as HTMLElement;
      const state = el.getAttribute("data-state") ?? "";
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("data-titlebar-route") ||
        el.tagName.toLowerCase();
      const cls = (el.className || "").toString().slice(0, 120);
      lines.push(
        `  [${i}] ${maskDynamicText(label)} state=${state} class=${maskDynamicText(cls)}`,
      );
    });
  }

  const island = container.querySelector(
    'button[aria-label*="Downloading"], button[aria-label*="Processing"], button[aria-label="Ready"]',
  );
  lines.push(
    `status-island: ${island ? maskDynamicText(island.getAttribute("aria-label") ?? "yes") : "hidden"}`,
  );

  return lines.join("\n");
}

/**
 * Compare fingerprints; on mismatch write expected/actual JSON for inspection.
 * Returns null when equal, else a human-readable message (and artifacts on disk).
 */
export function compareLayoutFingerprints(
  expected: ShellLayoutFingerprint,
  actual: ShellLayoutFingerprint,
): string | null {
  const exp = stableJson(expected);
  const act = stableJson(actual);
  if (exp === act) return null;

  ensureArtifactsDir();
  const slug = sanitize(actual.scenario || expected.scenario || "layout");
  const expectedPath = path.join(ARTIFACTS_DIR, `${slug}.expected.json`);
  const actualPath = path.join(ARTIFACTS_DIR, `${slug}.actual.json`);
  const diffPath = path.join(ARTIFACTS_DIR, `${slug}.diff.txt`);
  fs.writeFileSync(expectedPath, exp + "\n", "utf8");
  fs.writeFileSync(actualPath, act + "\n", "utf8");
  fs.writeFileSync(
    diffPath,
    [
      `scenario: ${slug}`,
      `tolerance: ${LAYOUT_BASELINE_TOLERANCE.mode}`,
      LAYOUT_BASELINE_TOLERANCE.note,
      "",
      "--- expected",
      exp,
      "--- actual",
      act,
    ].join("\n") + "\n",
    "utf8",
  );

  return (
    `Layout fingerprint mismatch for "${slug}". ` +
    `Inspect ${path.relative(process.cwd(), diffPath)}`
  );
}

export function assertLayoutFingerprint(
  expected: ShellLayoutFingerprint,
  actual: ShellLayoutFingerprint,
): void {
  const msg = compareLayoutFingerprints(expected, actual);
  if (msg) {
    throw new Error(msg);
  }
}

/** Write a baseline dump alongside vitest snapshots for local inspection. */
export function writeLayoutArtifact(
  scenario: string,
  payload: { fingerprint: ShellLayoutFingerprint; structure: string },
): string {
  ensureArtifactsDir();
  const slug = sanitize(scenario);
  const out = path.join(ARTIFACTS_DIR, `${slug}.baseline.json`);
  fs.writeFileSync(
    out,
    stableJson({
      fingerprint: payload.fingerprint,
      structure: payload.structure,
    }) + "\n",
    "utf8",
  );
  return out;
}

function ensureArtifactsDir(): void {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "layout";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export { ARTIFACTS_DIR, TITLEBAR_CONTRACT };
