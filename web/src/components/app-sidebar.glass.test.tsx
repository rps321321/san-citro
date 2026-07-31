/**
 * Regression: sidebar chrome must match the window frame contract.
 *
 * Symptom (2026-07-31): floating + large rounded corners made the glass rail
 * radius disagree with the OS/app window radius. Fix: flush rail, no custom
 * outer radius on the default (non-floating) variant; glass via .sidebar-glass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/components/ui/skiper-ui/skiper26", () => ({
  useThemeToggle: () => ({ toggleTheme: vi.fn() }),
}));

vi.mock("@/lib/telemetry", () => ({
  trackInteraction: vi.fn(),
}));

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={["/search"]}>
      <SidebarProvider defaultOpen>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe("AppSidebar glass chrome contract", () => {
  beforeEach(() => {
    cleanup();
    // Desktop rail (not Sheet): force non-mobile.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
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
  });

  afterEach(() => {
    cleanup();
  });

  it("does not use floating variant (avoids inset card radius vs window radius)", () => {
    const { container } = renderSidebar();
    const root = container.querySelector('[data-slot="sidebar"]');
    expect(root).toBeTruthy();
    // data-variant comes from Sidebar; default is "sidebar", not floating.
    expect(root?.getAttribute("data-variant")).not.toBe("floating");
    expect(root?.getAttribute("data-variant")).not.toBe("inset");
  });

  it("applies sidebar-glass and does not paint large outer radii on the default rail", () => {
    const { container } = renderSidebar();
    const inner = container.querySelector('[data-slot="sidebar-inner"]');
    expect(inner).toBeTruthy();
    const cls = inner?.className ?? "";
    expect(cls).toContain("sidebar-glass");
    // Outer radii only allowed under floating variant utilities.
    const withoutFloating = cls
      .split(/\s+/)
      .filter((t) => !t.startsWith("group-data-[variant=floating]:"))
      .join(" ");
    expect(withoutFloating).not.toMatch(/\brounded-2xl\b/);
    expect(withoutFloating).not.toMatch(/\brounded-r-2xl\b/);
    expect(withoutFloating).not.toMatch(/\brounded-l-2xl\b/);
    expect(withoutFloating).not.toMatch(/\brounded-xl\b/);
  });

  it("keeps the desktop rail flush to the left (no floating padding container)", () => {
    const { container } = renderSidebar();
    const box = container.querySelector('[data-slot="sidebar-container"]');
    expect(box).toBeTruthy();
    const cls = box?.className ?? "";
    // Floating/inset add p-2; default rail must not.
    expect(cls.split(/\s+/)).not.toContain("p-2");
  });

  it("uses plain brand text (no TextRepel) and no decorative hover arrows", () => {
    const { container, getByText } = renderSidebar();
    expect(getByText("San Citro")).toBeTruthy();
    expect(container.querySelector("[data-text-repel]")).toBeNull();
    // ArrowIcon from skiper99 rendered a chevron+line affordance; product nav is label-only.
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
    const nav = container.querySelector('[data-slot="sidebar-menu"]');
    expect(nav?.querySelector(".opacity-0")).toBeNull();
  });
});
