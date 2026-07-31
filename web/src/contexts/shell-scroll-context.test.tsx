/**
 * Ticket #59 — Shell scroll contract unit coverage.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ShellScrollProvider,
  useShellScroll,
  useShellScrollOptional,
} from "@/contexts/shell-scroll-context";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function providerWrapper({ children }: { children: ReactNode }) {
  return <ShellScrollProvider>{children}</ShellScrollProvider>;
}

describe("ShellScrollContext (#59)", () => {
  it("scrollToTop targets the main ref, not window", () => {
    const windowScrollTo = vi.fn();
    window.scrollTo = windowScrollTo;

    const { result } = renderHook(() => useShellScroll(), {
      wrapper: providerWrapper,
    });

    // Standalone scroller element standing in for shell <main>.
    const main = document.createElement("main");
    const mainScrollTo = vi.fn();
    Object.defineProperty(main, "scrollTo", {
      configurable: true,
      value: mainScrollTo,
    });
    result.current.mainRef.current = main;

    act(() => {
      result.current.scrollToTop();
    });

    expect(mainScrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: "auto",
    });
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("scrollToTop is a no-op when mainRef is unset", () => {
    const { result } = renderHook(() => useShellScroll(), {
      wrapper: providerWrapper,
    });
    expect(() => {
      act(() => {
        result.current.scrollToTop();
      });
    }).not.toThrow();
  });

  it("useShellScrollOptional returns null outside the provider", () => {
    const { result } = renderHook(() => useShellScrollOptional());
    expect(result.current).toBeNull();
  });

  it("useShellScrollOptional returns the contract inside the provider", () => {
    const { result } = renderHook(() => useShellScrollOptional(), {
      wrapper: providerWrapper,
    });
    expect(result.current).not.toBeNull();
    expect(typeof result.current?.scrollToTop).toBe("function");
  });

  it("respects an explicit behavior option", () => {
    const { result } = renderHook(() => useShellScroll(), {
      wrapper: providerWrapper,
    });
    const main = document.createElement("main");
    const mainScrollTo = vi.fn();
    Object.defineProperty(main, "scrollTo", {
      configurable: true,
      value: mainScrollTo,
    });
    result.current.mainRef.current = main;

    act(() => {
      result.current.scrollToTop({ behavior: "smooth" });
    });

    expect(mainScrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: "smooth",
    });
  });
});
