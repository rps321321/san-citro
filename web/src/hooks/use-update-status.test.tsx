import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";

import { useUpdateStatus } from "@/hooks/use-update-status";
import { installSanCitroMock, uninstallSanCitroMock } from "@/test/mock-san-citro";
import type { SanCitroApi, UpdateStatus } from "@/types";

describe("useUpdateStatus", () => {
  let statusListeners: Array<(s: UpdateStatus) => void>;
  let getUpdateStatus: ReturnType<typeof vi.fn>;
  let checkForUpdates: ReturnType<typeof vi.fn>;
  let quitAndInstall: ReturnType<typeof vi.fn>;
  let hydrateResolve: ((s: UpdateStatus) => void) | null;

  beforeEach(() => {
    cleanup();
    statusListeners = [];
    hydrateResolve = null;
    quitAndInstall = vi.fn(async () => {});
    checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      version: "1.2.2",
    }));
    getUpdateStatus = vi.fn(
      () =>
        new Promise<UpdateStatus>((resolve) => {
          hydrateResolve = resolve;
        })
    );
    installSanCitroMock({
      getUpdateStatus: getUpdateStatus as SanCitroApi["getUpdateStatus"],
      checkForUpdates: checkForUpdates as SanCitroApi["checkForUpdates"],
      quitAndInstall: quitAndInstall as SanCitroApi["quitAndInstall"],
      onUpdateStatus: (cb) => {
        statusListeners.push(cb);
        return () => {
          statusListeners = statusListeners.filter((l) => l !== cb);
        };
      },
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

  async function mountAndAwaitSubscribe() {
    const hook = renderHook(() => useUpdateStatus());
    await waitFor(() => expect(statusListeners.length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());
    return hook;
  }

  async function resolveHydrate(snapshot: UpdateStatus) {
    await act(async () => {
      if (!hydrateResolve) {
        throw new Error("hydrate not pending");
      }
      hydrateResolve(snapshot);
    });
  }

  it("starts idle before hydrate completes", async () => {
    const { result } = await mountAndAwaitSubscribe();
    expect(result.current.status).toEqual({ status: "idle" });
    expect(result.current.isReadyToInstall).toBe(false);
  });

  it("hydrates from getUpdateStatus when update already downloaded (missed push)", async () => {
    getUpdateStatus.mockResolvedValue({
      status: "downloaded",
      version: "1.2.2",
    });
    const { result } = renderHook(() => useUpdateStatus());
    await waitFor(() => {
      expect(result.current.status.status).toBe("downloaded");
    });
    expect(result.current.isReadyToInstall).toBe(true);
    expect(result.current.status.version).toBe("1.2.2");
  });

  it("applies live pushes: available → downloading → downloaded", async () => {
    const { result } = await mountAndAwaitSubscribe();
    await resolveHydrate({ status: "idle" });

    act(() => {
      push({ status: "available", version: "1.2.2" });
    });
    expect(result.current.status.status).toBe("available");
    expect(result.current.isReadyToInstall).toBe(false);

    act(() => {
      push({ status: "downloading", version: "1.2.2", percent: 42 });
    });
    expect(result.current.status.status).toBe("downloading");
    expect(result.current.status.percent).toBe(42);
    expect(result.current.isReadyToInstall).toBe(false);

    act(() => {
      push({ status: "downloaded", version: "1.2.2" });
    });
    expect(result.current.status.status).toBe("downloaded");
    expect(result.current.isReadyToInstall).toBe(true);
  });

  it("does not let a slower stale hydrate overwrite a newer live push", async () => {
    const { result } = await mountAndAwaitSubscribe();

    // Live push reaches downloaded while hydrate is still pending.
    act(() => {
      push({ status: "downloaded", version: "1.2.2" });
    });
    expect(result.current.isReadyToInstall).toBe(true);

    // Stale hydration resolves to older "available" — must be ignored.
    await resolveHydrate({ status: "available", version: "1.2.2" });

    expect(result.current.status.status).toBe("downloaded");
    expect(result.current.isReadyToInstall).toBe(true);
  });

  it("applies hydrate when no live push raced it", async () => {
    const { result } = await mountAndAwaitSubscribe();
    await resolveHydrate({
      status: "not-available",
      message: "up to date",
    });

    await waitFor(() => {
      expect(result.current.status.status).toBe("not-available");
    });
    expect(result.current.isReadyToInstall).toBe(false);
  });

  it("surfaces error and not-available live statuses without offering Restart", async () => {
    const { result } = await mountAndAwaitSubscribe();
    await resolveHydrate({ status: "idle" });

    act(() => {
      push({ status: "error", message: "network failed" });
    });
    expect(result.current.status.status).toBe("error");
    expect(result.current.status.message).toBe("network failed");
    expect(result.current.isReadyToInstall).toBe(false);

    act(() => {
      push({ status: "not-available" });
    });
    expect(result.current.status.status).toBe("not-available");
    expect(result.current.isReadyToInstall).toBe(false);
  });

  it("check() triggers API but does not write return value over live state", async () => {
    const { result } = await mountAndAwaitSubscribe();
    await resolveHydrate({ status: "idle" });

    // Live already advanced past the check return value.
    act(() => {
      push({ status: "downloaded", version: "1.2.2" });
    });

    let returned: UpdateStatus | undefined;
    await act(async () => {
      returned = await result.current.check();
    });

    expect(checkForUpdates).toHaveBeenCalled();
    expect(returned).toEqual({ status: "available", version: "1.2.2" });
    // Live state remains authoritative — check return must not clobber downloaded.
    expect(result.current.status.status).toBe("downloaded");
    expect(result.current.isReadyToInstall).toBe(true);
  });

  it("restart() calls quitAndInstall once", async () => {
    const { result } = await mountAndAwaitSubscribe();
    await resolveHydrate({ status: "idle" });

    act(() => {
      push({ status: "downloaded", version: "1.2.2" });
    });
    act(() => {
      result.current.restart();
    });
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = await mountAndAwaitSubscribe();
    unmount();
    expect(statusListeners.length).toBe(0);
  });
});
