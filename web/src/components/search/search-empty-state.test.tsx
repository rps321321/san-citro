/**
 * Ticket #57 — Pre-search empty state: guidance, example chips, local shortcuts,
 * format hints from SEARCH_EXTENSIONS, keyboard/SR affordances.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SearchEmptyState,
  SEARCH_EXAMPLE_QUERIES,
  SEARCH_FORMAT_HINTS,
} from "@/components/search/search-empty-state";
import { SEARCH_EXTENSIONS } from "@/components/search/search-toolbar";

afterEach(() => {
  cleanup();
});

describe("SearchEmptyState (#57)", () => {
  it("explains accepted query types", () => {
    render(<SearchEmptyState onExampleQuery={vi.fn()} />);
    expect(
      screen.getByText(/Search by title, author, ISBN, or identifier/i)
    ).toBeInTheDocument();
  });

  it("renders four example chips that invoke onExampleQuery with the query", async () => {
    const onExampleQuery = vi.fn();
    const user = userEvent.setup();
    render(<SearchEmptyState onExampleQuery={onExampleQuery} />);

    const list = screen.getByRole("list", { name: "Example searches" });
    expect(list).toBeInTheDocument();

    for (const example of SEARCH_EXAMPLE_QUERIES) {
      const chip = screen.getByRole("button", { name: example.label });
      expect(list).toContainElement(chip);
      await user.click(chip);
      expect(onExampleQuery).toHaveBeenLastCalledWith(example.query);
    }
    expect(onExampleQuery).toHaveBeenCalledTimes(SEARCH_EXAMPLE_QUERIES.length);
  });

  it("derives format hints from SEARCH_EXTENSIONS (same source as filters)", () => {
    render(<SearchEmptyState onExampleQuery={vi.fn()} />);
    const hint = document.querySelector("[data-search-format-hint]");
    expect(hint).not.toBeNull();

    const expected = SEARCH_EXTENSIONS.filter((e) => e.length > 0);
    expect(SEARCH_FORMAT_HINTS).toEqual(expected);
    for (const ext of expected) {
      expect(hint?.textContent).toMatch(new RegExp(ext, "i"));
    }
    // Empty "all formats" sentinel must not appear as a blank chip.
    expect(hint?.textContent).not.toMatch(/Formats:\s*·/);
  });

  it("hides Library and Activity shortcuts when not relevant", () => {
    render(<SearchEmptyState onExampleQuery={vi.fn()} />);
    expect(screen.queryByRole("navigation", { name: /Local library/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Library/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Activity/i })).not.toBeInTheDocument();
  });

  it("shows Library and Activity links only when requested", () => {
    render(
      <SearchEmptyState
        onExampleQuery={vi.fn()}
        showLibrary
        showActivity
      />
    );
    const nav = screen.getByRole("navigation", { name: /Local library shortcuts/i });
    const library = screen.getByRole("link", { name: /Open Library/i });
    const activity = screen.getByRole("link", { name: /Open Activity/i });
    expect(nav).toContainElement(library);
    expect(nav).toContainElement(activity);
    expect(library).toHaveAttribute("href", "#/library");
    expect(activity).toHaveAttribute("href", "#/activity");
  });

  it("shows only Library when Activity is not relevant", () => {
    render(<SearchEmptyState onExampleQuery={vi.fn()} showLibrary />);
    expect(screen.getByRole("link", { name: /Open Library/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Activity/i })).not.toBeInTheDocument();
  });

  it("exposes a labeled region (not a live status) for keyboard and SR users", () => {
    render(<SearchEmptyState onExampleQuery={vi.fn()} />);
    const region = screen.getByRole("region", { name: "Search tips" });
    expect(region).toHaveAttribute("data-search-empty-region");
    // Chips are focusable buttons (keyboard reachable).
    const first = screen.getByRole("button", {
      name: SEARCH_EXAMPLE_QUERIES[0].label,
    });
    first.focus();
    expect(first).toHaveFocus();
  });
});
