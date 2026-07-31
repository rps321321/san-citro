"use client";

import { StatusIsland } from "@/components/status-island";

// Frameless 36px title-bar strip (issue #53 / ADR-0016):
// - drag only on the content band
// - explicit no-drag safe-area matching native titleBarOverlay width
// - no custom min/max/close controls (Electron owns those)
export function AppHeader() {
  return (
    <header
      className="relative flex h-[var(--titlebar-height)] items-center bg-[var(--titlebar-bg)] text-[var(--titlebar-symbol)] pl-4"
      data-titlebar=""
    >
      <div className="app-region-drag relative flex min-h-0 min-w-0 flex-1 items-center self-stretch">
        <StatusIsland />
      </div>
      {/* Native caption-button strip: never place content or drag under it. */}
      <div
        className="app-region-no-drag shrink-0 self-stretch"
        style={{ width: "var(--titlebar-overlay-width)" }}
        aria-hidden="true"
        data-titlebar-overlay-safe-area=""
      />
    </header>
  );
}
