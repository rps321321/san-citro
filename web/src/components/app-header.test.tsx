/**
 * Title-bar layout contract (#53) + compact app header (#54):
 * - reserves an explicit native-control safe-area
 * - does not implement custom min/max/close controls
 * - drag lives on the content band only
 * - route label always present; Status Island stays centered
 * - interactive controls use app-region-no-drag
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AppHeader } from "@/components/app-header";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/command-palette";

vi.mock("@/contexts/active-downloads-context", () => ({
  useActiveDownloadCount: () => 0,
}));

vi.mock("@/lib/api-client", () => ({
  onAudiobookStatus: () => () => {},
}));

function renderHeader(path = "/search") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppHeader />
    </MemoryRouter>,
  );
}

describe("AppHeader title-bar safe-area (#53)", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("exposes a single native overlay safe-area spacer (no-drag)", () => {
    const { container } = renderHeader();
    const safe = container.querySelector(
      "[data-titlebar-overlay-safe-area]",
    ) as HTMLElement | null;
    expect(safe).toBeTruthy();
    expect(safe?.className).toContain("app-region-no-drag");
    expect(safe?.style.width).toBe("var(--titlebar-overlay-width)");
    expect(safe?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps drag on the content band, not the whole header", () => {
    const { container } = renderHeader();
    const header = container.querySelector("[data-titlebar]");
    expect(header).toBeTruthy();
    expect(header?.className).not.toContain("app-region-drag");
    const dragBand = header?.querySelector(".app-region-drag");
    expect(dragBand).toBeTruthy();
  });

  it("does not render custom window control buttons", () => {
    const { queryByRole, queryByLabelText } = renderHeader();
    expect(
      queryByRole("button", { name: /minimize|maximize|close|restore/i }),
    ).toBeNull();
    expect(queryByLabelText(/minimize|maximize|close|restore/i)).toBeNull();
  });
});

describe("AppHeader compact route context (#54)", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the current route label when idle (no download status)", () => {
    renderHeader("/search");
    const label = screen.getByText("Search");
    expect(label).toHaveAttribute("data-titlebar-route");
    // Status island button is hidden when idle — only command button is present.
    expect(
      screen.queryByRole("button", { name: /downloading|processing|ready/i }),
    ).toBeNull();
  });

  it("maps primary routes to compact labels", () => {
    for (const [path, label] of [
      ["/library", "Library"],
      ["/activity", "Activity"],
      ["/settings", "Settings"],
      ["/reader", "Reader"],
    ] as const) {
      cleanup();
      renderHeader(path);
      expect(screen.getByText(label)).toHaveAttribute("data-titlebar-route");
    }
  });

  it("shows a no-drag back control only on Reader", () => {
    renderHeader("/reader");
    const back = screen.getByRole("link", { name: /back to library/i });
    expect(back).toHaveAttribute("href", "/library");
    expect(back.className).toContain("app-region-no-drag");

    cleanup();
    const { container } = renderHeader("/search");
    expect(screen.queryByRole("link", { name: /back/i })).toBeNull();
    expect(container.querySelector("[data-titlebar-command]")).toBeTruthy();
  });

  it("keeps Status Island absolutely centered in the drag band", () => {
    const { container } = renderHeader("/activity");
    const dragBand = container.querySelector(".app-region-drag");
    // StatusIsland root is the absolute inset-0 centering wrapper.
    const islandRoot = dragBand?.querySelector(".absolute.inset-0") as
      | HTMLElement
      | null;
    expect(islandRoot).toBeTruthy();
    expect(islandRoot?.className).toMatch(/justify-center/);
    expect(islandRoot?.className).toMatch(/items-center/);
  });

  it("command button is no-drag and dispatches the open event", () => {
    renderHeader("/search");
    const cmd = screen.getByRole("button", { name: /open command palette/i });
    expect(cmd.className).toContain("app-region-no-drag");

    const spy = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, spy);
    cmd.click();
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, spy);
  });

  it("places the overlay safe-area after the command control (no native overlap)", () => {
    const { container } = renderHeader("/search");
    const header = container.querySelector("[data-titlebar]") as HTMLElement;
    const children = Array.from(header.children) as HTMLElement[];
    // [drag band, safe-area]
    expect(children).toHaveLength(2);
    expect(children[0]?.className).toContain("app-region-drag");
    expect(children[1]?.getAttribute("data-titlebar-overlay-safe-area")).toBe(
      "",
    );
    // Command lives inside the drag band, not under the overlay spacer.
    expect(
      children[0]?.querySelector("[data-titlebar-command]"),
    ).toBeTruthy();
    expect(
      children[1]?.querySelector("[data-titlebar-command]"),
    ).toBeNull();
  });
});
