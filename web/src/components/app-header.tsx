"use client";

import { Link, useLocation } from "react-router";
import { ChevronLeftIcon, SearchIcon } from "lucide-react";

import { StatusIsland } from "@/components/status-island";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/command-palette";
import { getRouteMeta } from "@/lib/route-meta";
import { Button } from "@/components/ui/button";

// Compact route-aware app header in the 36px title-bar strip (issue #54 / #53):
// - left: route label (+ optional back only where nested, e.g. Reader)
// - center: Status Island (absolute — does not shift when labels change)
// - right: command palette trigger, then native titleBarOverlay safe-area
// Empty regions stay draggable; interactive children use app-region-no-drag.
// Page-level h1 remains the document hierarchy; this is window context only.
export function AppHeader() {
  const { pathname } = useLocation();
  const meta = getRouteMeta(pathname);

  return (
    <header
      className="relative flex h-[var(--titlebar-height)] items-center bg-[var(--titlebar-bg)] text-[var(--titlebar-symbol)] pl-3"
      data-titlebar=""
    >
      <div className="app-region-drag relative flex min-h-0 min-w-0 flex-1 items-center self-stretch">
        {/* Left: compact route context */}
        <div
          className="z-10 flex min-w-0 max-w-[40%] items-center gap-0.5"
          data-titlebar-route-group=""
        >
          {meta.showBack && meta.backTo ? (
            <Link
              to={meta.backTo}
              aria-label={meta.backLabel ?? "Back"}
              className="app-region-no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--titlebar-symbol)] outline-none hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Link>
          ) : null}
          <span
            className="truncate text-xs font-medium tracking-tight text-[var(--titlebar-symbol)]"
            data-titlebar-route=""
          >
            {meta.label}
          </span>
        </div>

        {/* Center: activity pill — absolutely centered in the drag band */}
        <StatusIsland />

        {/* Right: command trigger (before native overlay safe-area) */}
        <div className="z-10 ml-auto flex shrink-0 items-center pr-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="app-region-no-drag text-[var(--titlebar-symbol)] hover:bg-muted/60"
            aria-label="Open command palette"
            title="Command palette (Ctrl+K)"
            data-titlebar-command=""
            onClick={() => {
              window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
            }}
          >
            <SearchIcon className="size-3.5" />
          </Button>
        </div>
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
