/**
 * Ticket #63 — Search results table scannability.
 *
 * Sticky header marker, 4-col hierarchy (not 8 equal columns), empty state.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import {
  SearchResultsTable,
  SearchResultsSkeleton,
} from "@/components/search/search-results-table";
import type { SearchResponse } from "@/types";

const SAMPLE: SearchResponse = {
  results: [
    {
      title: "Meditations",
      author: "Marcus Aurelius",
      year: 180,
      extension: "epub",
      md5: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      language: "English",
      filesize_bytes: 500_000,
      publisher: "",
      isbn13: "",
      cover_url: null,
    },
  ],
  total_count: 1,
  page: 1,
  has_next: false,
  has_prev: false,
  sort: "",
};

function renderTable(data: SearchResponse = SAMPLE) {
  return render(
    <SearchResultsTable
      data={data}
      resultsStale={false}
      resultsHeadingRef={createRef<HTMLDivElement>()}
      getDownloadState={() => "idle"}
      onDownload={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("SearchResultsTable scannability (#63)", () => {
  it("renders a desktop table with sticky header markers", () => {
    renderTable();
    const tableRoot = document.querySelector("[data-search-results-table]");
    expect(tableRoot).not.toBeNull();
    const header = document.querySelector("[data-search-results-header]");
    expect(header).not.toBeNull();
    const heads = header!.querySelectorAll("th");
    // Sticky lives on th so it sticks inside the shell scroller.
    for (const th of heads) {
      expect(th.className).toMatch(/sticky/);
      expect(th.className).toMatch(/top-0/);
      expect(th.className).toMatch(/bg-background/);
    }
  });

  it("does not use a nested horizontal overflow scroller that traps sticky", () => {
    renderTable();
    const tableRoot = document.querySelector("[data-search-results-table]");
    expect(tableRoot?.className).not.toMatch(/overflow-x-auto/);
    // No ui/Table outer overflow wrapper between border and <table>.
    expect(tableRoot?.querySelector("[data-slot='table-container']")).toBeNull();
  });

  it("uses four scannable columns: Cover, Title, Details, Status", () => {
    renderTable();
    const header = document.querySelector("[data-search-results-header]")!;
    expect(within(header as HTMLElement).getByText("Title")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("Details")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("Status")).toBeInTheDocument();
    // Cover is sr-only label
    expect(within(header as HTMLElement).getByText("Cover")).toBeInTheDocument();
    // No equal-weight Author / Year / Format / Size / Language headers
    expect(within(header as HTMLElement).queryByText("Author")).toBeNull();
    expect(within(header as HTMLElement).queryByText("Year")).toBeNull();
    expect(within(header as HTMLElement).queryByText("Format")).toBeNull();
    expect(within(header as HTMLElement).queryByText("Size")).toBeNull();
    expect(within(header as HTMLElement).queryByText("Language")).toBeNull();
  });

  it("keeps Status as the rightmost header", () => {
    renderTable();
    const heads = [
      ...document.querySelectorAll("[data-search-results-header] th"),
    ];
    expect(heads[heads.length - 1].textContent).toMatch(/Status/i);
  });

  it("renders title/author path for each result row", () => {
    renderTable();
    expect(screen.getByText("Meditations")).toHaveAttribute("data-result-title");
    expect(screen.getByText("Marcus Aurelius")).toHaveAttribute("data-result-author");
  });

  it("shows empty-state message spanning the four-column layout", () => {
    renderTable({ ...SAMPLE, results: [], total_count: 0 });
    const cell = screen.getByText(/No results found/i);
    expect(cell).toHaveAttribute("colSpan", "4");
  });

  it("skeleton mirrors the four-column header", () => {
    render(<SearchResultsSkeleton />);
    const skel = document.querySelector("[data-search-results-skeleton]");
    expect(skel).not.toBeNull();
    expect(within(skel as HTMLElement).getByText("Title")).toBeInTheDocument();
    expect(within(skel as HTMLElement).getByText("Details")).toBeInTheDocument();
    expect(within(skel as HTMLElement).getByText("Status")).toBeInTheDocument();
    expect(within(skel as HTMLElement).queryByText("Author")).toBeNull();
  });

  it("is not a mobile card grid (rows remain table rows)", () => {
    renderTable();
    expect(document.querySelectorAll("[data-search-result-row]").length).toBe(1);
    expect(document.querySelector("[data-search-results-table] table")).not.toBeNull();
    expect(document.querySelector("[data-search-card-grid]")).toBeNull();
  });
});
