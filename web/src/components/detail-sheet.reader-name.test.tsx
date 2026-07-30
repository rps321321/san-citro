/**
 * Ticket #30 — Reader open name includes extension when filename missing.
 *
 * Detail sheet Read handoff must synthesize a File display name with extension
 * when Library item has extension but empty filename; real filenames win.
 * Unreadable formats still hide the Read button (Readable format gate).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailSheet } from "@/components/detail-sheet";
import { openReader } from "@/lib/reader-nav";
import type { LibraryItem } from "@/types";

vi.mock("@/lib/reader-nav", () => ({
  openReader: vi.fn(),
}));

const MD5 = "26ef9f66be1268c180004715e19b1b30";

function bookItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    md5: MD5,
    title: "Sparse Metadata Book",
    filename: null,
    author: "Author",
    year: 2020,
    extension: "epub",
    content_type: null,
    language: "en",
    publisher: null,
    cover_url: null,
    filesize_bytes: 1024,
    completed_at: "2020-01-01",
    media_type: "book",
    variant: "book",
    status: null,
    container_type: null,
    folder_path: null,
    total_duration_seconds: null,
    track_count: null,
    error_message: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(openReader).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DetailSheet reader open display name (#30)", () => {
  it("with extension set and empty filename, openReader gets a name that includes the extension", async () => {
    const user = userEvent.setup();
    const item = bookItem({ filename: null, extension: "epub", title: "Sparse Metadata Book" });
    render(<DetailSheet item={item} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /read/i }));

    expect(openReader).toHaveBeenCalledTimes(1);
    const [, , filenameArg] = vi.mocked(openReader).mock.calls[0];
    expect(filenameArg).toMatch(/\.epub$/i);
    expect(filenameArg.length).toBeGreaterThan(".epub".length);
  });

  it("with a full filename present, that filename is preferred", async () => {
    const user = userEvent.setup();
    const item = bookItem({
      filename: "Real Title - Author.mobi",
      extension: "epub",
      title: "Ignored Title",
    });
    render(<DetailSheet item={item} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /read/i }));

    expect(openReader).toHaveBeenCalledWith(
      MD5,
      expect.any(String),
      "Real Title - Author.mobi"
    );
  });

  it("unreadable formats still do not offer Read", () => {
    const item = bookItem({ filename: null, extension: "pdf" });
    render(<DetailSheet item={item} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /read/i })).not.toBeInTheDocument();
    expect(openReader).not.toHaveBeenCalled();
  });
});
