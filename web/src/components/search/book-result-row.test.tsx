/**
 * Ticket #63 — Search results row scannability.
 *
 * Cover + title/author primary path; quiet meta; status labels without color alone;
 * missing cover/metadata placeholders; keyboard-focusable row.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BookResultRow,
  buildBookMetaParts,
  type BookDownloadUiState,
} from "@/components/search/book-result-row";
import type { BookRecord } from "@/types";

const FULL_BOOK: BookRecord = {
  title: "Atomic Habits",
  author: "James Clear",
  year: 2018,
  extension: "epub",
  md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  language: "English",
  filesize_bytes: 1_048_576,
  publisher: "Avery",
  isbn13: "9780735211292",
  cover_url: "https://example.com/cover.jpg",
};

function renderRow(
  overrides: {
    book?: Partial<BookRecord>;
    downloadState?: BookDownloadUiState;
    onDownload?: (book: BookRecord) => void;
  } = {}
) {
  const book = { ...FULL_BOOK, ...overrides.book };
  const onDownload = overrides.onDownload ?? vi.fn();
  const result = render(
    <table>
      <tbody>
        <BookResultRow
          book={book}
          downloadState={overrides.downloadState ?? "idle"}
          onDownload={onDownload}
        />
      </tbody>
    </table>
  );
  return { ...result, book, onDownload };
}

afterEach(() => {
  cleanup();
});

describe("BookResultRow scannability (#63)", () => {
  it("puts title and author on the primary path (author under title)", () => {
    renderRow();
    const title = screen.getByText("Atomic Habits");
    const author = screen.getByText("James Clear");
    expect(title).toHaveAttribute("data-result-title");
    expect(author).toHaveAttribute("data-result-author");
    // Author follows title in document order within the book cell.
    expect(
      title.compareDocumentPosition(author) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("does not render an equal-weight Author column separate from title", () => {
    renderRow();
    // Only one visible author node; not a sibling table header cell pair.
    expect(screen.getAllByText("James Clear")).toHaveLength(1);
    expect(document.querySelectorAll("[data-result-author]")).toHaveLength(1);
  });

  it("exposes quiet meta (format/year/size/language) without competing with title", () => {
    renderRow();
    const meta = document.querySelector("[data-result-meta]");
    expect(meta).not.toBeNull();
    expect(within(meta as HTMLElement).getByText("EPUB")).toBeInTheDocument();
    expect(document.querySelector("[data-result-year]")?.textContent).toBe("2018");
  });

  it("uses stable placeholders for missing title, author, and meta", () => {
    renderRow({
      book: {
        title: "",
        author: "",
        year: null,
        extension: "",
        language: "",
        filesize_bytes: Number.NaN as unknown as number,
      },
    });
    expect(screen.getByText("Untitled")).toBeInTheDocument();
    expect(screen.getByText("Unknown author")).toBeInTheDocument();
    const parts = buildBookMetaParts({
      ...FULL_BOOK,
      title: "",
      author: "",
      year: null,
      extension: "",
      language: "",
      filesize_bytes: undefined as unknown as number,
    });
    expect(parts.formatLabel).toBe("—");
    expect(parts.yearLabel).toBe("—");
    expect(parts.languageLabel).toBe("—");
    expect(parts.sizeLabel).toBe("Unknown");
  });

  it("shows a cover placeholder when cover URL and ISBN are missing", () => {
    renderRow({ book: { cover_url: null, isbn13: "" } });
    expect(document.querySelector("[data-cover-placeholder]")).not.toBeNull();
    expect(screen.queryByRole("img", { name: /Cover of/i })).toBeNull();
  });

  it("swaps to cover placeholder when the image fails to load", () => {
    renderRow();
    const img = screen.getByRole("img", { name: /Cover of Atomic Habits/i });
    fireEvent.error(img);
    expect(document.querySelector("[data-cover-placeholder]")).not.toBeNull();
  });

  it.each([
    ["idle", "available", /Download/i],
    ["queued", "queued", /Queued/i],
    ["downloading", "downloading", /Downloading/i],
    ["done", "done", /Downloaded/i],
  ] as const)(
    "download state %s is labeled (not color-only) as %s",
    (state, dataState, label) => {
      renderRow({ downloadState: state });
      const el = document.querySelector(`[data-download-state="${dataState}"]`);
      expect(el).not.toBeNull();
      expect(el?.textContent).toMatch(label);
    }
  );

  it("available Download control is a labeled button (not icon-only)", async () => {
    const user = userEvent.setup();
    const { onDownload, book } = renderRow({ downloadState: "idle" });
    const btn = screen.getByRole("button", { name: /Download Atomic Habits/i });
    expect(btn.textContent).toMatch(/Download/i);
    await user.click(btn);
    expect(onDownload).toHaveBeenCalledWith(book);
  });

  it("row is keyboard-focusable with a focus ring class", async () => {
    const user = userEvent.setup();
    renderRow();
    const row = document.querySelector("[data-search-result-row]") as HTMLElement;
    expect(row).toHaveAttribute("tabIndex", "0");
    await user.tab();
    // May land on row or skip depending on jsdom focusability of tr — force focus.
    row.focus();
    expect(document.activeElement).toBe(row);
    expect(row.className).toMatch(/focus-visible:ring/);
  });
});

describe("buildBookMetaParts", () => {
  it("joins format, year, size, and language for tooltips", () => {
    const parts = buildBookMetaParts(FULL_BOOK);
    expect(parts.combined).toContain("EPUB");
    expect(parts.combined).toContain("2018");
    expect(parts.combined).toContain("English");
  });
});
