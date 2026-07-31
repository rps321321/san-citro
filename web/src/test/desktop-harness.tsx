/**
 * Desktop shell harness for layout / window-chrome regression (issue #64).
 *
 * Renders AppShell + Search with deterministic bridge fixtures, forced theme,
 * desktop viewports (1360×920 / 1120×840), and reduced motion.
 */

import { type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ThemeProvider } from "next-themes";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";

import AppShell from "@/components/app-shell";
import SearchPage from "@/routes/search";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";
import type { SanCitroApi, SearchResponse, DownloadStatus } from "@/types";
import {
  DESKTOP_VIEWPORTS,
  FIXTURE_ACTIVE_DOWNLOAD,
  FIXTURE_SEARCH_EMPTY,
  FIXTURE_SEARCH_RESULTS,
  type DesktopViewportName,
} from "@/test/desktop-fixtures";

export type DesktopHarnessOptions = {
  theme?: "light" | "dark";
  viewport?: DesktopViewportName;
  /** When true, getDownloads returns a live downloading item (Status Island). */
  activeDownload?: boolean;
  /** Override search() responses. Default empty (pre-search empty UI). */
  searchResponse?: SearchResponse | ((params: { query: string }) => SearchResponse);
  /** Extra sanCitro overrides. */
  sanCitro?: Partial<SanCitroApi>;
  route?: string;
};

export type DesktopHarness = RenderResult & {
  theme: "light" | "dark";
  viewport: DesktopViewportName;
  viewportPx: { width: number; height: number };
  mock: SanCitroApi;
};

/**
 * Install desktop matchMedia + viewport dimensions.
 * Reduced-motion is always preferred so Motion opacity animations settle instantly.
 */
export function installDesktopEnvironment(
  viewport: DesktopViewportName = "default",
): { width: number; height: number } {
  const { width, height } = DESKTOP_VIEWPORTS[viewport];

  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
  Object.defineProperty(window, "outerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, "outerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });

  window.scrollTo = vi.fn();

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const q = query.toLowerCase();
      let matches = false;
      if (q.includes("prefers-reduced-motion") && q.includes("reduce")) {
        matches = true;
      } else if (q.includes("prefers-color-scheme") && q.includes("dark")) {
        matches = false;
      } else if (q.includes("max-width") && q.includes("767")) {
        // useIsMobile — desktop at both supported sizes
        matches = width < 768;
      } else if (q.includes("min-width")) {
        const m = q.match(/min-width:\s*(\d+)/);
        matches = m ? width >= Number(m[1]) : false;
      }
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });

  return { width, height };
}

/** Apply light/dark class on the document for shell chrome CSS variables. */
export function applyThemeClass(theme: "light" | "dark"): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {
    /* jsdom storage may be restricted */
  }
}

function searchResponder(
  response: DesktopHarnessOptions["searchResponse"],
): SanCitroApi["search"] {
  return async (params) => {
    if (typeof response === "function") {
      return response({ query: params.query });
    }
    if (response) return response;
    return FIXTURE_SEARCH_EMPTY;
  };
}

/**
 * Full shell composition: AppShell (sidebar + titlebar + Status Island + main)
 * with Search route. No live network.
 */
export function renderDesktopShell(
  options: DesktopHarnessOptions = {},
): DesktopHarness {
  const theme = options.theme ?? "dark";
  const viewport = options.viewport ?? "default";
  const viewportPx = installDesktopEnvironment(viewport);
  applyThemeClass(theme);

  const downloads: DownloadStatus[] = options.activeDownload
    ? [FIXTURE_ACTIVE_DOWNLOAD]
    : [];

  const mock = installSanCitroMock({
    search: searchResponder(options.searchResponse),
    getDownloads: async () => downloads,
    listLibrary: async () => ({
      items: [],
      facets: { content_types: [], extensions: [], languages: [] },
      total_eligible: 0,
      filtered_count: 0,
    }),
    getHistory: async () => [],
    ...options.sanCitro,
  });

  // AppShell mounts SidebarProvider with defaultOpen=true (expanded).
  // Collapse coverage toggles via [data-slot="sidebar-trigger"] after mount.

  const route = options.route ?? "/search";
  const ui: ReactElement = (
    <ThemeProvider
      attribute="class"
      defaultTheme={theme}
      forcedTheme={theme}
      enableSystem={false}
      storageKey="theme"
      disableTransitionOnChange
    >
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/search" element={<SearchPage />} />
            <Route path="/library" element={<div>Library stub</div>} />
            <Route path="/activity" element={<div>Activity stub</div>} />
            <Route path="/settings" element={<div>Settings stub</div>} />
            <Route path="/reader" element={<div>Reader stub</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>
  );

  const result = render(ui);

  return {
    ...result,
    theme,
    viewport,
    viewportPx,
    mock,
  };
}

/** Uninstall bridge + clear theme storage residue. */
export function teardownDesktopHarness(): void {
  uninstallSanCitroMock();
  try {
    localStorage.removeItem("theme");
  } catch {
    /* ignore */
  }
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
}

export { FIXTURE_SEARCH_RESULTS, FIXTURE_SEARCH_EMPTY, FIXTURE_ACTIVE_DOWNLOAD };
