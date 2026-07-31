/**
 * One-shot splash → main-window handoff (issue #62).
 *
 * Splash must stay until the renderer signals a meaningful shell paint
 * (or until a timeout / load-failure recovery path fires). Completing more
 * than once is a no-op so ready signal, timeout, and crash handlers can all
 * call the same entry point without racing.
 */

export type SplashHandoff = {
  /** @returns true if this call performed the handoff, false if already done. */
  complete: (reason: string) => boolean;
  readonly isDone: boolean;
  readonly reason: string | null;
};

export type SplashHandoffOptions = {
  closeSplash: () => void;
  showMain: () => void;
  log?: (message: string) => void;
};

export function createSplashHandoff(opts: SplashHandoffOptions): SplashHandoff {
  let done = false;
  let reason: string | null = null;

  return {
    complete(nextReason: string): boolean {
      if (done) return false;
      done = true;
      reason = nextReason;
      opts.log?.(`[main] Splash handoff: ${nextReason}`);
      try {
        opts.closeSplash();
      } catch {
        // Splash may already be destroyed.
      }
      try {
        opts.showMain();
      } catch {
        // Main window may already be destroyed during quit.
      }
      return true;
    },
    get isDone() {
      return done;
    },
    get reason() {
      return reason;
    },
  };
}

/** Default max time splash may remain if renderer-ready never arrives. */
export const SPLASH_HANDOFF_TIMEOUT_MS = 15_000;
