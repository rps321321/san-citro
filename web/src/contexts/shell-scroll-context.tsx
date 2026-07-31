"use client";

/**
 * Shell main-content scrolling contract.
 *
 * `#main-content` owns overflow scrolling (not `window`). Routes that need to
 * reset or position content should use this context instead of DOM selectors
 * or `window.scrollTo`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

export type ShellScrollToTopOptions = {
  /** Instant by default; prefer "auto" over "smooth" unless a11y-justified. */
  behavior?: ScrollBehavior;
};

export type ShellScrollContextValue = {
  /** Ref attached to the shell `<main id="main-content">` scroller. */
  mainRef: RefObject<HTMLElement | null>;
  /** Scroll the shell main panel to the top. No-op if the ref is unset. */
  scrollToTop: (options?: ShellScrollToTopOptions) => void;
};

const ShellScrollContext = createContext<ShellScrollContextValue | null>(null);

export function ShellScrollProvider({ children }: { children: ReactNode }) {
  const mainRef = useRef<HTMLElement | null>(null);

  const scrollToTop = useCallback((options?: ShellScrollToTopOptions) => {
    const el = mainRef.current;
    if (!el) return;
    el.scrollTo({
      top: 0,
      left: 0,
      behavior: options?.behavior ?? "auto",
    });
  }, []);

  const value = useMemo(
    () => ({ mainRef, scrollToTop }),
    [scrollToTop]
  );

  return (
    <ShellScrollContext.Provider value={value}>
      {children}
    </ShellScrollContext.Provider>
  );
}

/** Required when a route needs the shell scroller (throws outside provider). */
export function useShellScroll(): ShellScrollContextValue {
  const ctx = useContext(ShellScrollContext);
  if (!ctx) {
    throw new Error("useShellScroll must be used within ShellScrollProvider");
  }
  return ctx;
}

/**
 * Optional variant for presentational hooks/tests that may render outside the
 * full shell. Returns null when no provider is mounted.
 */
export function useShellScrollOptional(): ShellScrollContextValue | null {
  return useContext(ShellScrollContext);
}
