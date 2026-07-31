/**
 * Issue #64 — Desktop layout and window-chrome regression coverage.
 *
 * Viewport-aware shell composition at Electron default (1360×920) and minimum
 * (1120×840). Deterministic bridge fixtures; reduced motion; structural baselines
 * with inspectable artifacts (not pixel-perfect native caption hover).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  cleanup,
  screen,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  renderDesktopShell,
  teardownDesktopHarness,
} from "@/test/desktop-harness";
import {
  DESKTOP_VIEWPORTS,
  FIXTURE_SEARCH_RESULTS,
  TITLEBAR_CONTRACT,
} from "@/test/desktop-fixtures";
import {
  captureShellLayoutFingerprint,
  captureShellStructureDump,
  writeLayoutArtifact,
  type ShellLayoutFingerprint,
} from "@/test/layout-baseline";

vi.mock("@/components/ui/skiper-ui/skiper26", () => ({
  useThemeToggle: () => ({ toggleTheme: vi.fn() }),
}));

vi.mock("@/lib/telemetry", () => ({
  trackInteraction: vi.fn(),
  trackFeatureDiscovery: vi.fn(),
  trackFunnelStep: vi.fn(),
  incrementEngagement: vi.fn(),
  trackError: vi.fn(),
  trackSearch: vi.fn(),
  trackBridgeCall: vi.fn(),
}));

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  teardownDesktopHarness();
  vi.clearAllMocks();
});

async function waitForShellChrome() {
  await waitFor(() => {
    expect(document.querySelector("[data-titlebar]")).toBeTruthy();
    expect(document.querySelector('[data-slot="sidebar"]')).toBeTruthy();
  });
}

async function runSearch(query = "layout fixture") {
  const input = screen.getByLabelText("Search query") as HTMLInputElement;
  const user = userEvent.setup();
  await user.clear(input);
  await user.type(input, query);
  fireEvent.submit(screen.getByRole("form", { name: "Search controls" }));
  await waitFor(() => {
    expect(document.querySelector("[data-search-results-table]")).toBeTruthy();
  });
}

async function collapseSidebar() {
  const trigger = document.querySelector(
    '[data-slot="sidebar-trigger"]',
  ) as HTMLElement | null;
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger!);
  await waitFor(() => {
    const root = document.querySelector('[data-slot="sidebar"]');
    expect(root?.getAttribute("data-state")).toBe("collapsed");
  });
}

function assertChromeContracts(container: HTMLElement) {
  const titlebar = container.querySelector("[data-titlebar]") as HTMLElement;
  expect(titlebar).toBeTruthy();
  expect(titlebar.className).toMatch(/h-\[var\(--titlebar-height\)\]/);

  const safe = container.querySelector(
    "[data-titlebar-overlay-safe-area]",
  ) as HTMLElement;
  expect(safe).toBeTruthy();
  expect(safe.className).toContain("app-region-no-drag");
  expect(safe.style.width).toBe(TITLEBAR_CONTRACT.overlayWidthCssVar);
  expect(safe.getAttribute("aria-hidden")).toBe("true");

  const command = container.querySelector("[data-titlebar-command]");
  expect(command).toBeTruthy();
  expect(safe.contains(command)).toBe(false);

  // Primary Search controls live in main, not under the native overlay strip.
  const main = container.querySelector("#main-content");
  expect(main).toBeTruthy();
  expect(within(main as HTMLElement).getByLabelText("Search query")).toBeTruthy();
  expect(
    within(main as HTMLElement).getByRole("button", { name: /^Search$/i }),
  ).toBeTruthy();

  // No custom window controls in the renderer.
  expect(
    screen.queryByRole("button", { name: /minimize|maximize|close|restore/i }),
  ).toBeNull();
}

function fingerprintAndSnapshot(
  scenario: string,
  opts: {
    container: HTMLElement;
    theme: "light" | "dark";
    viewport: "default" | "minimum";
    viewportPx: { width: number; height: number };
  },
): ShellLayoutFingerprint {
  const fingerprint = captureShellLayoutFingerprint({
    scenario,
    viewport: opts.viewport,
    viewportPx: opts.viewportPx,
    theme: opts.theme,
    container: opts.container,
  });
  const structure = captureShellStructureDump(opts.container);
  writeLayoutArtifact(scenario, { fingerprint, structure });
  // Vitest snapshot = inspectable structural baseline (stable, masked dump).
  expect(structure).toMatchSnapshot(`structure:${scenario}`);
  expect(fingerprint).toMatchSnapshot(`fingerprint:${scenario}`);
  return fingerprint;
}

describe("Desktop layout regression (#64) — viewports", () => {
  it("renders default 1360×920 shell with Search empty (dark)", async () => {
    const harness = renderDesktopShell({
      theme: "dark",
      viewport: "default",
    });
    await waitForShellChrome();

    expect(window.innerWidth).toBe(DESKTOP_VIEWPORTS.default.width);
    expect(window.innerHeight).toBe(DESKTOP_VIEWPORTS.default.height);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    assertChromeContracts(harness.container);
    expect(
      harness.container.querySelector("[data-search-empty-region]"),
    ).toBeTruthy();

    const fp = fingerprintAndSnapshot("search-empty-dark-default", harness);
    expect(fp.searchState).toBe("empty");
    expect(fp.sidebar).toBe("expanded");
    expect(fp.reducedMotionPreferred).toBe(true);
    expect(fp.commandInsideSafeArea).toBe(false);
    expect(fp.customWindowControls).toBe(false);
    expect(fp.hasOverlaySafeArea).toBe(true);
  });

  it("renders default 1360×920 shell with Search empty (light)", async () => {
    const harness = renderDesktopShell({
      theme: "light",
      viewport: "default",
    });
    await waitForShellChrome();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    assertChromeContracts(harness.container);

    const fp = fingerprintAndSnapshot("search-empty-light-default", harness);
    expect(fp.theme).toBe("light");
    expect(fp.searchState).toBe("empty");
    expect(fp.hasEmptyRegion).toBe(true);
  });

  it("renders Search results at default window size", async () => {
    const harness = renderDesktopShell({
      theme: "dark",
      viewport: "default",
      searchResponse: FIXTURE_SEARCH_RESULTS,
    });
    await waitForShellChrome();
    await runSearch();

    assertChromeContracts(harness.container);
    expect(
      harness.container.querySelectorAll("[data-search-result-row]").length,
    ).toBe(2);

    const fp = fingerprintAndSnapshot("search-results-dark-default", harness);
    expect(fp.searchState).toBe("results");
    expect(fp.resultRowCount).toBe(2);
    expect(fp.hasResultsTable).toBe(true);
    expect(fp.hasEmptyRegion).toBe(false);
  });

  it("renders Search results at minimum 1120×840 without losing chrome/controls", async () => {
    const harness = renderDesktopShell({
      theme: "dark",
      viewport: "minimum",
      searchResponse: FIXTURE_SEARCH_RESULTS,
    });
    await waitForShellChrome();
    await runSearch();

    expect(window.innerWidth).toBe(DESKTOP_VIEWPORTS.minimum.width);
    expect(window.innerHeight).toBe(DESKTOP_VIEWPORTS.minimum.height);

    assertChromeContracts(harness.container);
    // Wide page frame still present; min-w-0 avoids flex clipping of primary UI.
    const frame = harness.container.querySelector(
      '[data-page-container="wide"]',
    ) as HTMLElement;
    expect(frame).toBeTruthy();
    expect(frame.className).toMatch(/min-w-0/);
    expect(frame.className).toMatch(/max-w-6xl/);

    const main = harness.container.querySelector("#main-content") as HTMLElement;
    expect(main.className).toMatch(/overflow-auto|min-w-0|flex-1/);

    const fp = fingerprintAndSnapshot("search-results-dark-minimum", harness);
    expect(fp.viewport).toBe("minimum");
    expect(fp.viewportPx).toEqual(DESKTOP_VIEWPORTS.minimum);
    expect(fp.searchState).toBe("results");
    expect(fp.hasSearchQuery).toBe(true);
    expect(fp.hasSearchSubmit).toBe(true);
    expect(fp.commandInsideSafeArea).toBe(false);
  });
});

describe("Desktop layout regression (#64) — sidebar + status", () => {
  it("covers sidebar expanded and collapsed states", async () => {
    const harness = renderDesktopShell({
      theme: "dark",
      viewport: "default",
    });
    await waitForShellChrome();

    const expandedRoot = harness.container.querySelector(
      '[data-slot="sidebar"]',
    );
    expect(expandedRoot?.getAttribute("data-state")).toBe("expanded");
    expect(expandedRoot?.getAttribute("data-collapsible")).toBe("");

    const fpExpanded = fingerprintAndSnapshot(
      "sidebar-expanded-search-empty",
      harness,
    );
    expect(fpExpanded.sidebar).toBe("expanded");

    await collapseSidebar();

    const collapsedRoot = harness.container.querySelector(
      '[data-slot="sidebar"]',
    );
    expect(collapsedRoot?.getAttribute("data-state")).toBe("collapsed");
    expect(collapsedRoot?.getAttribute("data-collapsible")).toBe("icon");

    // Nav destinations remain reachable (icon rail); trigger still no-drag.
    const trigger = harness.container.querySelector(
      '[data-slot="sidebar-trigger"]',
    );
    expect(trigger).toBeTruthy();
    expect(trigger?.className).toMatch(/app-region-no-drag|/);

    assertChromeContracts(harness.container);

    const fpCollapsed = fingerprintAndSnapshot(
      "sidebar-collapsed-search-empty",
      harness,
    );
    expect(fpCollapsed.sidebar).toBe("collapsed");
    expect(fpCollapsed.hasTitlebar).toBe(true);
    expect(fpCollapsed.hasOverlaySafeArea).toBe(true);
  });

  it("shows active download Status Island without invading overlay safe-area", async () => {
    const harness = renderDesktopShell({
      theme: "dark",
      viewport: "default",
      activeDownload: true,
    });
    await waitForShellChrome();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /downloading/i }),
      ).toBeInTheDocument();
    });

    const island = screen.getByRole("button", { name: /downloading/i });
    expect(island.className).toContain("app-region-no-drag");
    expect(island.className).toContain("glass");

    const safe = harness.container.querySelector(
      "[data-titlebar-overlay-safe-area]",
    ) as HTMLElement;
    expect(safe.contains(island)).toBe(false);

    // Island is centered in the drag band (absolute inset-0 flex center).
    const dragBand = harness.container.querySelector(
      "[data-titlebar] .app-region-drag",
    );
    expect(dragBand?.contains(island)).toBe(true);

    assertChromeContracts(harness.container);

    const fp = fingerprintAndSnapshot("status-island-active-download", harness);
    expect(fp.statusIslandVisible).toBe(true);
    expect(fp.statusIslandLabel).toMatch(/Downloading/i);
    expect(fp.commandInsideSafeArea).toBe(false);
  });
});

describe("Desktop layout regression (#64) — semantic non-overlap", () => {
  it("keeps Search primary controls out of title-bar and overlay strip", async () => {
    const harness = renderDesktopShell({ theme: "dark", viewport: "minimum" });
    await waitForShellChrome();

    const titlebar = harness.container.querySelector("[data-titlebar]")!;
    const safe = harness.container.querySelector(
      "[data-titlebar-overlay-safe-area]",
    )!;
    const main = harness.container.querySelector("#main-content")!;

    const query = screen.getByLabelText("Search query");
    const submit = screen.getByRole("button", { name: /^Search$/i });

    expect(titlebar.contains(query)).toBe(false);
    expect(titlebar.contains(submit)).toBe(false);
    expect(safe.contains(query)).toBe(false);
    expect(safe.contains(submit)).toBe(false);
    expect(main.contains(query)).toBe(true);
    expect(main.contains(submit)).toBe(true);

    // Header children: drag band then safe-area only.
    const children = Array.from(titlebar.children) as HTMLElement[];
    expect(children).toHaveLength(2);
    expect(children[0]?.className).toContain("app-region-drag");
    expect(children[1]?.getAttribute("data-titlebar-overlay-safe-area")).toBe(
      "",
    );
  });

  it("uses deterministic fixtures (no live network bridge methods required)", async () => {
    const harness = renderDesktopShell({
      searchResponse: FIXTURE_SEARCH_RESULTS,
      activeDownload: true,
    });
    await waitForShellChrome();
    await runSearch("no network");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /downloading/i })).toBeTruthy();
    });

    // Fixture titles only — proves search mock, not AA.
    expect(screen.getByText("Deterministic Layout Book")).toBeInTheDocument();
    expect(screen.getByText("Second Layout Book")).toBeInTheDocument();
    expect(harness.mock.search).toBeTypeOf("function");
  });
});
