import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UpdateBanner } from "@/components/update-banner";
import { installSanCitroMock, uninstallSanCitroMock } from "@/test/mock-san-citro";
import type { SanCitroApi, UpdateStatus } from "@/types";

describe("UpdateBanner", () => {
  let mock: SanCitroApi;
  let statusListeners: Array<(s: UpdateStatus) => void>;
  let quitAndInstall: ReturnType<typeof vi.fn>;
  let getUpdateStatus: ReturnType<typeof vi.fn>;
  let hydrateResolve: ((s: UpdateStatus) => void) | null;

  beforeEach(() => {
    cleanup();
    statusListeners = [];
    hydrateResolve = null;
    quitAndInstall = vi.fn(async () => {});
    getUpdateStatus = vi.fn(
      () =>
        new Promise<UpdateStatus>((resolve) => {
          hydrateResolve = resolve;
        })
    );
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

  function push(status: UpdateStatus) {
    for (const cb of [...statusListeners]) {
      cb(status);
    }
  }

  async function resolveHydrate(snapshot: UpdateStatus) {
    await act(async () => {
      if (!hydrateResolve) {
        throw new Error("hydrate not pending");
      }
      hydrateResolve(snapshot);
    });
  }

  it("stays hidden when idle and no events", async () => {
    getUpdateStatus.mockResolvedValue({ status: "idle" as const });
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
    await resolveHydrate({ status: "idle" });
    act(() => {
      push({
        status: "downloaded",
        version: "1.2.2",
      });
    });
    const status = await within(container).findByRole("status");
    expect(within(status).getByText(/Update ready \(v1\.2\.2\)/i)).toBeInTheDocument();
    await userEvent.click(within(status).getByRole("button", { name: /restart/i }));
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not show install UI while only available (download not finished)", async () => {
    getUpdateStatus.mockResolvedValue({
      status: "available",
      version: "1.2.2",
    });
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());
    await waitFor(() => {
      expect(within(container).queryByRole("button", { name: /restart/i })).toBeNull();
    });
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  it("does not show Restart while downloading (progress is not install-ready)", async () => {
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(statusListeners.length).toBeGreaterThanOrEqual(1));
    await resolveHydrate({ status: "idle" });
    act(() => {
      push({ status: "downloading", version: "1.2.2", percent: 55 });
    });
    expect(within(container).queryByRole("button", { name: /restart/i })).toBeNull();
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  it("keeps Restart when live downloaded beats a stale available hydrate", async () => {
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(statusListeners.length).toBeGreaterThanOrEqual(1));

    act(() => {
      push({ status: "downloaded", version: "1.2.2" });
    });
    const statusEl = await within(container).findByRole("status");
    expect(within(statusEl).getByRole("button", { name: /restart/i })).toBeInTheDocument();

    // Stale hydrate arrives late with available — banner must stay ready.
    await resolveHydrate({ status: "available", version: "1.2.2" });
    expect(within(container).getByRole("button", { name: /restart/i })).toBeInTheDocument();
  });

  it("stays hidden for error and not-available", async () => {
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(statusListeners.length).toBeGreaterThanOrEqual(1));
    await resolveHydrate({ status: "idle" });

    act(() => {
      push({ status: "error", message: "boom" });
    });
    expect(container).toBeEmptyDOMElement();

    act(() => {
      push({ status: "not-available" });
    });
    expect(container).toBeEmptyDOMElement();
  });
});
