/**
 * Startup shell fallback (issue #62): root must never paint a blank frame
 * while HashRouter is gated behind client mount.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { StartupShell } from "@/components/startup-shell";
import Page, { ClientRoutedApp } from "@/app/page";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";

// Heavy shell deps are irrelevant to the mount-gate contract.
vi.mock("@/components/app-shell", () => ({
  default: () => <div data-testid="app-shell">app shell</div>,
}));

vi.mock("@/routes/search", () => ({ default: () => null }));
vi.mock("@/routes/library", () => ({ default: () => null }));
vi.mock("@/routes/activity", () => ({ default: () => null }));
vi.mock("@/routes/settings", () => ({ default: () => null }));
vi.mock("@/routes/reader", () => ({ default: () => null }));

describe("StartupShell", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders shell geometry (sidebar + titlebar + loading content)", () => {
    const { container } = render(<StartupShell />);
    const root = container.querySelector("[data-startup-shell]");
    expect(root).toBeTruthy();
    expect(root?.getAttribute("role")).toBe("status");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("[data-titlebar]")).toBeTruthy();
    expect(screen.getByText(/Loading library/i)).toBeTruthy();
    // Sidebar rail present (desktop width class matches SIDEBAR_WIDTH 14rem).
    const rail = container.querySelector("aside.sidebar-glass");
    expect(rail).toBeTruthy();
    expect(rail?.className ?? "").toContain("w-[14rem]");
  });
});

describe("ClientRoutedApp mount gate (issue #62)", () => {
  afterEach(() => {
    cleanup();
  });

  it("paints StartupShell while ready=false (not null / blank)", () => {
    const { container } = render(<ClientRoutedApp ready={false} />);
    expect(container.querySelector("[data-startup-shell]")).toBeTruthy();
    expect(container.querySelector("[data-testid='app-shell']")).toBeNull();
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("paints HashRouter AppShell when ready=true", () => {
    render(<ClientRoutedApp ready={true} />);
    expect(screen.getByTestId("app-shell")).toBeTruthy();
  });
});

describe("Page mount + renderer-ready (issue #62)", () => {
  afterEach(() => {
    cleanup();
    uninstallSanCitroMock();
    vi.restoreAllMocks();
  });

  it("promotes to HashRouter shell after client mount", async () => {
    installSanCitroMock();
    render(<Page />);
    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBeTruthy();
    });
  });

  it("signals notifyRendererReady after client paint", async () => {
    const notifyRendererReady = vi.fn();
    installSanCitroMock({ notifyRendererReady });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (cb: FrameRequestCallback) => {
        return setTimeout(() => cb(performance.now()), 0) as unknown as number;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    });

    render(<Page />);
    await waitFor(() => {
      expect(notifyRendererReady).toHaveBeenCalled();
    });
  });
});
