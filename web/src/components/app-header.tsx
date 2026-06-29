"use client";

import { StatusIsland } from "@/components/status-island";

// The 36px frameless title-bar strip: draggable, hosting the centered Dynamic
// Island (live status) — which replaces the old active-downloads badge. The right
// padding reserves room for the OS window-controls overlay.
export function AppHeader() {
  return (
    <header className="app-region-drag relative flex h-9 items-center bg-sidebar pl-4 pr-[140px]">
      <StatusIsland />
    </header>
  );
}
