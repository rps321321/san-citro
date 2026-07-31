/**
 * Ticket #27 — Search filters must re-scrape with committed filter values.
 *
 * With results already on screen, changing format/language or clearing filters
 * must call search() with the filters currently shown (not a stale prior render).
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchPage from "@/routes/search";
import { ActiveDownloadsProvider } from "@/contexts/active-downloads-context";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";
import type { SearchResponse } from "@/types";

type SearchCallParams = {
  query: string;
  page?: number;
  extension?: string;
  language?: string;
  sort?: string;
};

const SAMPLE_RESULTS: SearchResponse = {
  results: [
    {
      title: "Atomic Habits",
      author: "James Clear",
      year: 2018,
      extension: "epub",
      md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      language: "English",
      filesize_bytes: 1_024_000,
      publisher: "Avery",
      isbn13: "9780735211292",
    },
  ],
  total_count: 1,
  page: 1,
  has_next: false,
  has_prev: false,
};

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
  // Search scrolls to top after success; jsdom may not implement this.
  window.scrollTo = vi.fn();
});

async function searchAndWaitForResults(
  user: ReturnType<typeof userEvent.setup>,
  searchMock: ReturnType<typeof vi.fn<(params: SearchCallParams) => Promise<SearchResponse>>>
) {
  await user.type(screen.getByLabelText("Search query"), "habits");
  await user.click(screen.getByRole("button", { name: /^Search$/i }));
  await waitFor(() => {
    expect(searchMock).toHaveBeenCalled();
  });
  await screen.findByText("Atomic Habits");
}

describe("Search filters re-scrape with committed values (#27)", () => {
  it("re-searches with the new format when format filter changes", async () => {
    const searchMock = vi.fn(async (_params: SearchCallParams) => SAMPLE_RESULTS);
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWaitForResults(user, searchMock);
    const callsAfterInitial = searchMock.mock.calls.length;

    await user.click(screen.getByLabelText("Filter by file extension"));
    await user.click(await screen.findByRole("option", { name: "EPUB" }));

    await waitFor(() => {
      expect(searchMock.mock.calls.length).toBeGreaterThan(callsAfterInitial);
    });

    const lastCall = lastSearchParams(searchMock);
    expect(lastCall.query).toBe("habits");
    expect(lastCall.extension).toBe("epub");
    expect(lastCall.page).toBe(1);
  });

  it("re-searches with the new language when language filter changes", async () => {
    const searchMock = vi.fn(async (_params: SearchCallParams) => SAMPLE_RESULTS);
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWaitForResults(user, searchMock);
    const callsAfterInitial = searchMock.mock.calls.length;

    await user.click(screen.getByLabelText("Filter by language"));
    await user.click(await screen.findByRole("option", { name: "English" }));

    await waitFor(() => {
      expect(searchMock.mock.calls.length).toBeGreaterThan(callsAfterInitial);
    });

    const lastCall = lastSearchParams(searchMock);
    expect(lastCall.query).toBe("habits");
    expect(lastCall.language).toBe("English");
    expect(lastCall.page).toBe(1);
  });

  it("re-searches without filters when Clear filters is clicked", async () => {
    const searchMock = vi.fn(async (_params: SearchCallParams) => SAMPLE_RESULTS);
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await searchAndWaitForResults(user, searchMock);

    // Apply a format filter first so Clear is available and a filtered call is recorded.
    await user.click(screen.getByLabelText("Filter by file extension"));
    await user.click(await screen.findByRole("option", { name: "EPUB" }));
    await waitFor(() => {
      expect(lastSearchParams(searchMock).extension).toBe("epub");
    });
    const callsAfterFilter = searchMock.mock.calls.length;

    await user.click(screen.getByRole("button", { name: /Clear filters/i }));

    await waitFor(() => {
      expect(searchMock.mock.calls.length).toBeGreaterThan(callsAfterFilter);
    });

    const lastCall = lastSearchParams(searchMock);
    expect(lastCall.query).toBe("habits");
    expect(lastCall.extension).toBeUndefined();
    expect(lastCall.language).toBeUndefined();
    expect(lastCall.page).toBe(1);
  });
});
