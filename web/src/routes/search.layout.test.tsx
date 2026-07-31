/**
 * Ticket #51 — Bounded Search page layout and visual hierarchy.
 *
 * Asserts page header, PageContainer wide frame, toolbar structure, and
 * intentional empty-state region without changing search behavior.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SearchPage from "@/routes/search";
import { ActiveDownloadsProvider } from "@/contexts/active-downloads-context";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";

function renderSearch() {
  return render(
    <ActiveDownloadsProvider>
      <SearchPage />
    </ActiveDownloadsProvider>
  );
}

afterEach(() => {
  cleanup();
  uninstallSanCitroMock();
});

describe("Search layout (#51)", () => {
  it("shows a page title and supporting description", () => {
    installSanCitroMock();
    renderSearch();

    const heading = screen.getByRole("heading", { level: 1, name: "Search" });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveClass("type-page-title");
    expect(
      screen.getByText("Find books by title, author, ISBN, or identifier.")
    ).toBeInTheDocument();
  });

  it("wraps content in a wide PageContainer without constraining via main", () => {
    installSanCitroMock();
    const { container } = renderSearch();

    const frame = container.querySelector('[data-page-container="wide"]');
    expect(frame).not.toBeNull();
    expect(frame?.className).toMatch(/max-w-6xl/);
    expect(frame?.className).toMatch(/mx-auto/);
    expect(frame?.className).toMatch(/min-w-0/);
    // Header + toolbar live inside the bounded frame.
    expect(frame).toContainElement(
      screen.getByRole("heading", { level: 1, name: "Search" })
    );
    expect(frame).toContainElement(screen.getByLabelText("Search query"));
  });

  it("exposes primary search controls and a secondary filter row", () => {
    installSanCitroMock();
    renderSearch();

    expect(screen.getByRole("form", { name: "Search controls" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search query")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Search$/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by file extension")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by language")).toBeInTheDocument();

    const filters = document.querySelector("[data-search-filters]");
    expect(filters).not.toBeNull();
    expect(filters).toContainElement(screen.getByLabelText("Filter by file extension"));
    expect(filters).toContainElement(screen.getByLabelText("Filter by language"));
  });

  it("centers the pre-search empty state in an intentional region", () => {
    installSanCitroMock();
    renderSearch();

    const region = document.querySelector("[data-search-empty-region]");
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("aria-label", "Search tips");
    expect(region?.className).toMatch(/min-h-/);
    expect(region?.className).toMatch(/justify-center/);
    expect(region).toHaveTextContent(/title, author, ISBN, or identifier/i);
    expect(
      screen.getByRole("button", { name: /The Pragmatic Programmer/i })
    ).toBeInTheDocument();
  });
});
