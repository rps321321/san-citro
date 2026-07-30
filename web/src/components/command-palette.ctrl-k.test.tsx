/**
 * Ticket #29 — Ctrl/Cmd+K owns the Command palette only.
 *
 * Search must not also bind that chord for focus. "/" still focuses Search
 * when not typing in another field. Escape dismisses the palette.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "next-themes";
import { CommandPalette } from "@/components/command-palette";
import SearchPage from "@/routes/search";
import { ActiveDownloadsProvider } from "@/contexts/active-downloads-context";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";

/** Shell subtree: palette + Search (both window keydown listeners). */
function ShellWithSearchAndPalette() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <MemoryRouter initialEntries={["/search"]}>
        <ActiveDownloadsProvider>
          <SearchPage />
          <CommandPalette />
        </ActiveDownloadsProvider>
      </MemoryRouter>
    </ThemeProvider>
  );
}

function getSearchInput(): HTMLInputElement {
  return screen.getByLabelText("Search query") as HTMLInputElement;
}

async function openPaletteWithCtrlK(
  user: ReturnType<typeof userEvent.setup>
) {
  await user.keyboard("{Control>}k{/Control}");
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText("Type a command...")
    ).toBeInTheDocument();
  });
}

beforeEach(() => {
  installSanCitroMock();
  window.scrollTo = vi.fn();
  // next-themes reads matchMedia; jsdom does not implement it.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  // cmdk List uses ResizeObserver + scrollIntoView.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  uninstallSanCitroMock();
  vi.restoreAllMocks();
});

describe("Ctrl/Cmd+K command palette ownership (#29)", () => {
  it("opens the palette on Ctrl+K without focusing Search via a second handler", async () => {
    const user = userEvent.setup();
    render(<ShellWithSearchAndPalette />);

    const searchInput = getSearchInput();
    // Blur so we start from a neutral focus (not the search field).
    searchInput.blur();
    expect(document.activeElement).not.toBe(searchInput);

    const focusSpy = vi.spyOn(searchInput, "focus");

    await openPaletteWithCtrlK(user);

    // Palette is open.
    expect(screen.getByPlaceholderText("Type a command...")).toBeInTheDocument();
    // Search must not have been focused by a competing Ctrl+K handler.
    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(searchInput);
  });

  it("opens the palette on Cmd+K (meta) without focusing Search", async () => {
    const user = userEvent.setup();
    render(<ShellWithSearchAndPalette />);

    const searchInput = getSearchInput();
    searchInput.blur();
    const focusSpy = vi.spyOn(searchInput, "focus");

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Type a command...")
      ).toBeInTheDocument();
    });

    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(searchInput);
  });

  it("toggles the palette closed on a second Ctrl+K", async () => {
    const user = userEvent.setup();
    render(<ShellWithSearchAndPalette />);

    await openPaletteWithCtrlK(user);
    await user.keyboard("{Control>}k{/Control}");

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("Type a command...")
      ).not.toBeInTheDocument();
    });
  });

  it("closes the palette on Escape", async () => {
    const user = userEvent.setup();
    render(<ShellWithSearchAndPalette />);

    await openPaletteWithCtrlK(user);
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("Type a command...")
      ).not.toBeInTheDocument();
    });
  });

  it("still focuses Search on / when not typing in another field", async () => {
    const user = userEvent.setup();
    render(<ShellWithSearchAndPalette />);

    const searchInput = getSearchInput();
    searchInput.blur();
    expect(document.activeElement).not.toBe(searchInput);

    await user.keyboard("/");

    await waitFor(() => {
      expect(document.activeElement).toBe(searchInput);
    });
  });
});
