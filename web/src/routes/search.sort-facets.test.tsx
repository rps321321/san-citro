/**
 * Ticket #61 — Search sorting and facets authoritative across the result set.
 *
 * Sort is a Search-boundary param (not page-only column reordering).
 * Format/language options render from capabilities. Pagination preserves sort.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchPage from "@/routes/search";
import { ActiveDownloadsProvider } from "@/contexts/active-downloads-context";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";
import type { SearchCapabilities, SearchResponse } from "@/types";

type SearchCallParams = {
  query: string;
  page?: number;
  extension?: string;
  language?: string;
  sort?: string;
};

const CAPABILITIES: SearchCapabilities = {
  sorts: [
    { value: "", label: "Relevance" },
    { value: "newest", label: "Newest" },
    { value: "largest", label: "Largest" },
  ],
  extensions: [
    { value: "epub", label: "EPUB" },
    { value: "pdf", label: "PDF" },
    { value: "newfmt", label: "NEWFMT" },
  ],
  languages: [
    { value: "English", label: "English" },
    { value: "German", label: "German" },
  ],
};

function pageResults(
  page: number,
  hasNext: boolean,
  hasPrev: boolean,
  title = `Book page ${page}`
): SearchResponse {
  return {
    results: [
      {
        title,
        author: "Author",
        year: 2020,
        extension: "epub",
        md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        language: "English",
        filesize_bytes: 1_024_000,
        publisher: "Pub",
        isbn13: "9780735211292",
      },
    ],
    total_count: 1,
    page,
    has_next: hasNext,
    has_prev: hasPrev,
    sort: "",
    capabilities: CAPABILITIES,
  };
}

function lastSearchParams(
  searchMock: ReturnType<typeof vi.fn<(params: SearchCallParams) => Promise<SearchResponse>>>
): SearchCallParams {
  const calls = searchMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

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
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.scrollTo = vi.fn();
});

async function searchAndWait(
  user: ReturnType<typeof userEvent.setup>,
  searchMock: ReturnType<typeof vi.fn<(params: SearchCallParams) => Promise<SearchResponse>>>
) {
  await user.type(screen.getByLabelText("Search query"), "habits");
  await user.click(screen.getByRole("button", { name: /^Search$/i }));
  await waitFor(() => {
    expect(searchMock).toHaveBeenCalled();
  });
  await screen.findByText(/Book page/);
}

describe("Search authoritative sort and facets (#61)", () => {
  it("defaults to relevance (no sort param) on first search", async () => {
    const searchMock = vi.fn(async () => pageResults(1, true, false));
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWait(user, searchMock);

    const first = lastSearchParams(searchMock);
    expect(first.query).toBe("habits");
    expect(first.sort).toBeUndefined();
    expect(first.page).toBe(1);
  });

  it("re-searches with alternate sort and resets to page 1", async () => {
    const searchMock = vi.fn(async (params: SearchCallParams) => {
      const page = params.page ?? 1;
      return {
        ...pageResults(page, page === 1, page > 1),
        sort: params.sort ?? "",
      };
    });
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWait(user, searchMock);
    const callsAfterInitial = searchMock.mock.calls.length;

    await user.click(screen.getByLabelText("Sort results"));
    await user.click(await screen.findByRole("option", { name: "Newest" }));

    await waitFor(() => {
      expect(searchMock.mock.calls.length).toBeGreaterThan(callsAfterInitial);
    });

    const last = lastSearchParams(searchMock);
    expect(last.sort).toBe("newest");
    expect(last.page).toBe(1);
    expect(last.query).toBe("habits");
  });

  it("preserves selected sort across pagination", async () => {
    const searchMock = vi.fn(async (params: SearchCallParams) => {
      const page = params.page ?? 1;
      return {
        ...pageResults(page, page === 1, page > 1),
        sort: params.sort ?? "",
      };
    });
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWait(user, searchMock);

    await user.click(screen.getByLabelText("Sort results"));
    await user.click(await screen.findByRole("option", { name: "Largest" }));
    await waitFor(() => {
      expect(lastSearchParams(searchMock).sort).toBe("largest");
    });

    await user.click(screen.getByLabelText(/go to next page/i));
    await waitFor(() => {
      expect(lastSearchParams(searchMock).page).toBe(2);
    });

    const page2 = lastSearchParams(searchMock);
    expect(page2.sort).toBe("largest");
    expect(page2.query).toBe("habits");
  });

  it("renders format options returned from search capabilities", async () => {
    const searchMock = vi.fn(async () => pageResults(1, false, false));
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWait(user, searchMock);

    await user.click(screen.getByLabelText("Filter by file extension"));
    // Backend-only extension not in historic hard-coded list — proves props path.
    expect(await screen.findByRole("option", { name: "NEWFMT" })).toBeInTheDocument();
  });

  it("does not present column headers as sortable (no page-only global sort)", async () => {
    const searchMock = vi.fn(async () => pageResults(1, false, false));
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWait(user, searchMock);

    const table = screen.getByRole("table");
    // SortableHead buttons previously lived in column headers; plain TableHead has none.
    const headerButtons = within(table).queryAllByRole("button");
    // Only row actions (download etc.) may be buttons inside the table — not Title/Year/Size heads.
    for (const btn of headerButtons) {
      const label = (btn.textContent ?? "").trim();
      expect(label).not.toMatch(/^(Title|Year|Size)$/i);
    }
    // No aria-sort on headers (would imply interactive column sort).
    expect(table.querySelectorAll("[aria-sort]").length).toBe(0);
  });
});
