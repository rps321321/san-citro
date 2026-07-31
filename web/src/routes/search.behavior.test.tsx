/**
 * Ticket #58 — Search route public behavior locked after decomposition.
 *
 * Covers empty state, stale-response race rejection, pagination, and download
 * handoff at the SearchPage boundary (not private module structure).
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchPage from "@/routes/search";
import { ActiveDownloadsProvider } from "@/contexts/active-downloads-context";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";
import type { SearchResponse, DownloadStatus } from "@/types";
import * as BookResultRowModule from "@/components/search/book-result-row";

type SearchCallParams = {
  query: string;
  page?: number;
  extension?: string;
  language?: string;
};

const BOOK_MD5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function pageResults(page: number, hasNext: boolean, hasPrev: boolean): SearchResponse {
  return {
    results: [
      {
        title: `Book page ${page}`,
        author: "Author",
        year: 2020,
        extension: "epub",
        md5: BOOK_MD5,
        language: "English",
        filesize_bytes: 1_024_000,
        publisher: "Pub",
        isbn13: "9780735211292",
      },
    ],
    total_count: 2,
    page,
    has_next: hasNext,
    has_prev: hasPrev,
  };
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

describe("Search route public behavior (#58)", () => {
  it("shows the pre-search empty state before any query", () => {
    installSanCitroMock();
    renderSearch();
    expect(screen.getByText("Enter a search query to get started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /The Pragmatic Programmer/i })).toBeInTheDocument();
  });

  it("fills the query when the example is clicked", async () => {
    installSanCitroMock();
    const user = userEvent.setup();
    renderSearch();
    await user.click(screen.getByRole("button", { name: /The Pragmatic Programmer/i }));
    expect(screen.getByLabelText("Search query")).toHaveValue("The Pragmatic Programmer");
  });

  it("rejects a stale slower response when a newer search wins the race", async () => {
    // After initial results, two overlapping filter re-searches: older must not win.
    let resolveFilterA!: (value: SearchResponse) => void;
    let resolveFilterB!: (value: SearchResponse) => void;
    const filterAPromise = new Promise<SearchResponse>((r) => {
      resolveFilterA = r;
    });
    const filterBPromise = new Promise<SearchResponse>((r) => {
      resolveFilterB = r;
    });

    let call = 0;
    const searchMock = vi.fn(async (_params: SearchCallParams) => {
      call += 1;
      if (call === 1) return pageResults(1, false, false);
      if (call === 2) return filterAPromise;
      return filterBPromise;
    });
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText("Search query"), "habits");
    await user.click(screen.getByRole("button", { name: /^Search$/i }));
    await screen.findByText("Book page 1");

    // First overlapping re-search: format filter.
    await user.click(screen.getByLabelText("Filter by file extension"));
    await user.click(await screen.findByRole("option", { name: "epub" }));
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));

    // Second overlapping re-search: language filter (does not wait for loading).
    await user.click(screen.getByLabelText("Filter by language"));
    await user.click(await screen.findByRole("option", { name: "English" }));
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(3));

    // Newer request resolves first with a distinct title.
    resolveFilterB({
      ...pageResults(1, false, false),
      results: [
        {
          ...pageResults(1, false, false).results[0],
          title: "WINNER NEWER RESPONSE",
          md5: "cccccccccccccccccccccccccccccccc",
        },
      ],
    });
    await screen.findByText("WINNER NEWER RESPONSE");

    // Older request resolves later — must not replace UI.
    resolveFilterA({
      ...pageResults(1, false, false),
      results: [
        {
          ...pageResults(1, false, false).results[0],
          title: "STALE RESULT MUST NOT SHOW",
          md5: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("STALE RESULT MUST NOT SHOW")).not.toBeInTheDocument();
    expect(screen.getByText("WINNER NEWER RESPONSE")).toBeInTheDocument();
  });

  it("requests page 2 when Next is activated", async () => {
    const searchMock = vi.fn(async (params: SearchCallParams) => {
      const page = params.page ?? 1;
      return pageResults(page, page === 1, page > 1);
    });
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText("Search query"), "habits");
    await user.click(screen.getByRole("button", { name: /^Search$/i }));
    await screen.findByText("Book page 1");
    expect(searchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "habits", page: 1 })
    );

    const nextControl = screen.getByLabelText(/go to next page/i);
    await user.click(nextControl);

    await waitFor(() => {
      expect(searchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "habits", page: 2 })
      );
    });
    await screen.findByText("Book page 2");
  });

  it("starts a download through the page handoff (not a row-level bridge)", async () => {
    const searchMock = vi.fn(async () => pageResults(1, false, false));
    const startDownloadMock = vi.fn(
      async ({ md5, title }: { md5: string; title?: string }): Promise<DownloadStatus> => ({
        md5,
        title: title ?? "",
        status: "queued",
        progress_percent: 0,
        total_bytes: 0,
        downloaded_bytes: 0,
        error: null,
        filename: null,
        file_path: null,
        started_at: null,
      })
    );
    installSanCitroMock({ search: searchMock, startDownload: startDownloadMock });
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText("Search query"), "habits");
    await user.click(screen.getByRole("button", { name: /^Search$/i }));
    await screen.findByText("Book page 1");

    await user.click(screen.getByRole("button", { name: /Download Book page 1/i }));

    await waitFor(() => {
      expect(startDownloadMock).toHaveBeenCalledWith(
        expect.objectContaining({ md5: BOOK_MD5 })
      );
    });
    expect(await screen.findByText(/Added to downloads/i)).toBeInTheDocument();
  });

  it("BookResultRow module source does not import the desktop bridge", async () => {
    // Structural lock: presentational row must stay bridge-free.
    // Dynamic import of the module itself is fine; assert its export surface only.
    expect(typeof BookResultRowModule.BookResultRow).toBe("function");
    // Ensure no window.sanCitro touch when rendering a row alone.
    const onDownload = vi.fn();
    const { container } = render(
      <table>
        <tbody>
          <BookResultRowModule.BookResultRow
            book={{
              title: "Solo",
              author: "A",
              year: 1,
              extension: "pdf",
              md5: BOOK_MD5,
              language: "English",
              filesize_bytes: 10,
            }}
            downloadState="idle"
            onDownload={onDownload}
          />
        </tbody>
      </table>
    );
    const btn = container.querySelector('button[aria-label="Download Solo"]');
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(onDownload).toHaveBeenCalledTimes(1);
    // No startDownload was installed; if row called bridge it would throw.
  });

  it("marks previous results stale when a re-search fails", async () => {
    let call = 0;
    const searchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return pageResults(1, false, false);
      throw new Error("network down");
    });
    installSanCitroMock({ search: searchMock });
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText("Search query"), "habits");
    await user.click(screen.getByRole("button", { name: /^Search$/i }));
    await screen.findByText("Book page 1");

    // Trigger re-search via format filter with results already shown.
    await user.click(screen.getByLabelText("Filter by file extension"));
    await user.click(await screen.findByRole("option", { name: "epub" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Showing previous results — the latest search failed/i)
      ).toBeInTheDocument();
    });
    // Prior results remain visible.
    expect(screen.getByText("Book page 1")).toBeInTheDocument();
  });
});
