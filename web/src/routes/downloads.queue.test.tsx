/**
 * Ticket #31 — Active downloads queue copy uses ahead correctly.
 *
 * queuePosition is 1-based: pos 1 → "Next in queue"; pos N>1 → "{N-1} ahead".
 * Non-queued cards show no queue text.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import DownloadsPage from "@/routes/downloads";
import { ActiveDownloadsProvider } from "@/contexts/active-downloads-context";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";
import type { DownloadStatus } from "@/types";

function queued(md5: string, title: string): DownloadStatus {
  return {
    md5,
    title,
    status: "queued",
    progress_percent: 0,
    total_bytes: 0,
    downloaded_bytes: 0,
    error: null,
    filename: null,
    file_path: null,
    started_at: null,
  };
}

function downloading(md5: string, title: string): DownloadStatus {
  return {
    md5,
    title,
    status: "downloading",
    progress_percent: 10,
    total_bytes: 1000,
    downloaded_bytes: 100,
    error: null,
    filename: null,
    file_path: null,
    started_at: 1_700_000_000,
  };
}

afterEach(() => {
  cleanup();
  uninstallSanCitroMock();
});

describe("Active downloads queue copy (#31)", () => {
  it("shows Next in queue for pos 1 and N-1 ahead for later queued items", async () => {
    const first = queued("a".repeat(32), "First Queued Book");
    const second = queued("b".repeat(32), "Second Queued Book");

    installSanCitroMock({
      getDownloads: async () => [first, second],
    });

    render(
      <ActiveDownloadsProvider>
        <DownloadsPage />
      </ActiveDownloadsProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("First Queued Book")).toBeInTheDocument();
      expect(screen.getByText("Second Queued Book")).toBeInTheDocument();
    });

    expect(screen.getByText("Next in queue")).toBeInTheDocument();
    expect(screen.getByText("1 ahead in queue")).toBeInTheDocument();
    // Must not echo the raw 1-based index for position 2.
    expect(screen.queryByText("2 ahead in queue")).not.toBeInTheDocument();
  });

  it("does not show queue text on non-queued downloads", async () => {
    const active = downloading("c".repeat(32), "Active Download Book");
    const waiting = queued("d".repeat(32), "Waiting Queued Book");

    installSanCitroMock({
      getDownloads: async () => [active, waiting],
    });

    render(
      <ActiveDownloadsProvider>
        <DownloadsPage />
      </ActiveDownloadsProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Active Download Book")).toBeInTheDocument();
      expect(screen.getByText("Waiting Queued Book")).toBeInTheDocument();
    });

    // Sole queued item is next; downloading card has no queue label.
    expect(screen.getByText("Next in queue")).toBeInTheDocument();
    expect(screen.queryByText(/ahead in queue/)).not.toBeInTheDocument();

    const activeTitle = screen.getByText("Active Download Book");
    const activeCard = activeTitle.closest(".outline-none") ?? activeTitle.parentElement;
    expect(activeCard?.textContent).not.toMatch(/Next in queue|ahead in queue/);
  });
});
