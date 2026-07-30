import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UpdateBanner } from "@/components/update-banner";
import { installSanCitroMock, uninstallSanCitroMock } from "@/test/mock-san-citro";
import type { SanCitroApi, UpdateStatus } from "@/types";

describe("UpdateBanner", () => {
  let mock: SanCitroApi;
  let statusListeners: Array<(s: UpdateStatus) => void>;
  let quitAndInstall: ReturnType<typeof vi.fn>;
  let getUpdateStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup();
    statusListeners = [];
    quitAndInstall = vi.fn(async () => {});
    getUpdateStatus = vi.fn(async () => ({ status: "idle" as const }));
    mock = installSanCitroMock({
      getUpdateStatus: getUpdateStatus as SanCitroApi["getUpdateStatus"],
      onUpdateStatus: (cb) => {
        statusListeners.push(cb);
        return () => {
          statusListeners = statusListeners.filter((l) => l !== cb);
        };
      },
      quitAndInstall: quitAndInstall as SanCitroApi["quitAndInstall"],
    });
  });

  afterEach(() => {
    cleanup();
    uninstallSanCitroMock();
  });

  it("stays hidden when idle and no events", async () => {
    const { container } = render(<UpdateBanner />);
    await waitFor(() => {
      expect(getUpdateStatus).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("hydrates from getUpdateStatus when update already downloaded (missed push)", async () => {
    getUpdateStatus.mockResolvedValue({
      status: "downloaded",
      version: "1.2.2",
    });
    mock.getUpdateStatus = getUpdateStatus as SanCitroApi["getUpdateStatus"];
    window.sanCitro = mock;
    const { container } = render(<UpdateBanner />);
    const status = await within(container).findByRole("status");
    expect(within(status).getByText(/Update ready \(v1\.2\.2\)/i)).toBeInTheDocument();
    expect(within(status).getByRole("button", { name: /restart/i })).toBeInTheDocument();
  });

  it("shows restart after push event reaches downloaded", async () => {
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(statusListeners.length).toBeGreaterThanOrEqual(1));
    statusListeners[statusListeners.length - 1]!({
      status: "downloaded",
      version: "1.2.2",
    });
    const status = await within(container).findByRole("status");
    expect(within(status).getByText(/Update ready \(v1\.2\.2\)/i)).toBeInTheDocument();
    await userEvent.click(within(status).getByRole("button", { name: /restart/i }));
    expect(quitAndInstall).toHaveBeenCalled();
  });

  it("does not show install UI while only available (download not finished)", async () => {
    getUpdateStatus.mockResolvedValue({
      status: "available",
      version: "1.2.2",
    });
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());
    expect(within(container).queryByRole("button", { name: /restart/i })).toBeNull();
    expect(container.querySelector("[role='status']")).toBeNull();
  });
});
