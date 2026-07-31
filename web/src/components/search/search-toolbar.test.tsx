/**
 * Ticket #60 — Search control affordances and focus states.
 * Ticket #61 — Sort + facet options driven by capabilities props.
 *
 * Semantic coverage for enabled, disabled, loading, focus-group wiring,
 * primary height, and stable Search ↔ Searching… label width.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { SearchToolbar } from "@/components/search/search-toolbar";
import { BOOTSTRAP_SEARCH_CAPABILITIES } from "@/lib/search-capabilities";

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof SearchToolbar>> = {}
) {
  const props: React.ComponentProps<typeof SearchToolbar> = {
    query: "",
    onQueryChange: vi.fn(),
    extension: "",
    language: "",
    sort: "",
    extensions: BOOTSTRAP_SEARCH_CAPABILITIES.extensions,
    languages: BOOTSTRAP_SEARCH_CAPABILITIES.languages,
    sorts: BOOTSTRAP_SEARCH_CAPABILITIES.sorts,
    isLoading: false,
    activeFilterCount: 0,
    searchInputRef: createRef<HTMLInputElement>(),
    onSubmit: vi.fn((e) => e.preventDefault()),
    onExtensionChange: vi.fn(),
    onLanguageChange: vi.fn(),
    onSortChange: vi.fn(),
    onClearFilters: vi.fn(),
    ...overrides,
  };
  return { ...render(<SearchToolbar {...props} />), props };
}

afterEach(() => {
  cleanup();
});

describe("SearchToolbar affordances (#60)", () => {
  it("disables the primary Search button when the query is empty", () => {
    renderToolbar({ query: "" });
    const submit = screen.getByRole("button", { name: /^Search$/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("data-search-submit");
    // Default variant disabled recipe: muted surface, not opacity-alone.
    expect(submit.className).toMatch(/disabled:bg-muted/);
    expect(submit.className).toMatch(/disabled:text-muted-foreground/);
    expect(submit.className).toMatch(/disabled:opacity-100/);
  });

  it("enables Search when the query has non-whitespace text", () => {
    renderToolbar({ query: "atomic habits" });
    const submit = screen.getByRole("button", { name: /^Search$/i });
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute("aria-busy");
  });

  it("exposes loading state without dropping accessible busy semantics", () => {
    renderToolbar({ query: "habits", isLoading: true });
    const submit = screen.getByRole("button", { name: /Searching/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(submit).toHaveTextContent("Searching…");
  });

  it("pins submit label width so Search and Searching… share a grid cell", () => {
    const { rerender } = renderToolbar({ query: "habits", isLoading: false });
    const submit = screen.getByRole("button", { name: /^Search$/i });
    const grid = submit.querySelector(".inline-grid");
    expect(grid).not.toBeNull();

    const sizer = grid?.querySelector(".invisible");
    expect(sizer).not.toBeNull();
    expect(sizer).toHaveTextContent("Searching…");
    expect(sizer).toHaveAttribute("aria-hidden", "true");

    rerender(
      <SearchToolbar
        query="habits"
        onQueryChange={vi.fn()}
        extension=""
        language=""
        sort=""
        extensions={BOOTSTRAP_SEARCH_CAPABILITIES.extensions}
        languages={BOOTSTRAP_SEARCH_CAPABILITIES.languages}
        sorts={BOOTSTRAP_SEARCH_CAPABILITIES.sorts}
        isLoading={true}
        activeFilterCount={0}
        searchInputRef={createRef<HTMLInputElement>()}
        onSubmit={vi.fn((e) => e.preventDefault())}
        onExtensionChange={vi.fn()}
        onLanguageChange={vi.fn()}
        onSortChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    const loading = screen.getByRole("button", { name: /Searching/i });
    const loadingGrid = loading.querySelector(".inline-grid");
    expect(loadingGrid?.querySelector(".invisible")).toHaveTextContent("Searching…");
    expect(loading).toHaveTextContent("Searching…");
  });

  it("wires group + group-focus-within so the field icon can respond to focus", () => {
    renderToolbar({ query: "" });
    const field = document.querySelector("[data-search-field]");
    const icon = document.querySelector("[data-search-icon]");
    expect(field).not.toBeNull();
    expect(field?.className.split(/\s+/)).toContain("group");
    // Lucide SVG className can be a non-string in jsdom; read the attribute.
    const iconClass = icon?.getAttribute("class") ?? "";
    expect(iconClass).toMatch(/group-focus-within:text-foreground/);
  });

  it("sizes the primary input and submit around 40px (h-10)", () => {
    renderToolbar({ query: "x" });
    const input = screen.getByLabelText("Search query");
    const submit = screen.getByRole("button", { name: /^Search$/i });
    expect(input.className.split(/\s+/)).toContain("h-10");
    expect(submit.className.split(/\s+/)).toContain("h-10");
  });

  it("keeps focus-visible ring classes on primary input and submit", () => {
    renderToolbar({ query: "x" });
    const input = screen.getByLabelText("Search query");
    const submit = screen.getByRole("button", { name: /^Search$/i });
    expect(input.className).toMatch(/focus-visible:ring-/);
    expect(submit.className).toMatch(/focus-visible:ring-/);
  });

  it("keeps filters quieter at default height under a secondary row", () => {
    renderToolbar({ query: "", activeFilterCount: 1, extension: "epub" });
    const filters = document.querySelector("[data-search-filters]");
    expect(filters).not.toBeNull();
    const format = screen.getByLabelText("Filter by file extension");
    expect(filters).toContainElement(format);
    // Filters stay default Select height (h-8), not primary h-10.
    expect(format.className).toMatch(/data-\[size=default\]:h-8|h-8/);
    expect(format.className).not.toMatch(/\bh-10\b/);
  });

  it("submits the form when enabled and preserves form semantics", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    renderToolbar({ query: "habits", onSubmit });
    await user.click(screen.getByRole("button", { name: /^Search$/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("SearchToolbar capabilities (#61)", () => {
  it("renders format options from capabilities props, not hard-coded constants", async () => {
    const user = userEvent.setup();
    renderToolbar({
      extensions: [
        { value: "epub", label: "EPUB" },
        { value: "xyz", label: "XYZ" },
      ],
    });
    await user.click(screen.getByLabelText("Filter by file extension"));
    expect(await screen.findByRole("option", { name: "XYZ" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "EPUB" })).toBeInTheDocument();
  });

  it("exposes an authoritative Sort control with relevance default", () => {
    renderToolbar({ sort: "" });
    const sort = screen.getByLabelText("Sort results");
    expect(sort).toBeInTheDocument();
    expect(sort).toHaveTextContent("Relevance");
  });
});
