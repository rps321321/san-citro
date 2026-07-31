/**
 * Title-bar layout contract (issue #53):
 * - reserves an explicit native-control safe-area
 * - does not implement custom min/max/close controls
 * - drag lives on the content band only
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AppHeader } from "@/components/app-header";

vi.mock("@/contexts/active-downloads-context", () => ({
  useActiveDownloadCount: () => 0,
}));

vi.mock("@/lib/api-client", () => ({
  onAudiobookStatus: () => () => {},
}));

function renderHeader() {
  return render(
    <MemoryRouter>
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
    const { container, queryByRole, queryByLabelText } = renderHeader();
    expect(queryByRole("button", { name: /minimize|maximize|close|restore/i })).toBeNull();
    expect(queryByLabelText(/minimize|maximize|close|restore/i)).toBeNull();
    // No glyph buttons that look like caption controls.
    expect(container.querySelectorAll("button").length).toBeLessThanOrEqual(1);
  });
});
