"use client";

import { Outlet } from "react-router";

import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { UpdateBanner } from "@/components/update-banner";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TitlebarSync } from "@/components/titlebar-sync";
import { InPagePlayer } from "@/components/in-page-player";
import { CommandPalette } from "@/components/command-palette";
import { PlayerProvider, usePlayer } from "@/contexts/player-context";
import { ActiveDownloadsProvider } from "@/contexts/active-downloads-context";
import {
  ShellScrollProvider,
  useShellScroll,
} from "@/contexts/shell-scroll-context";

// The persistent SPA shell: sidebar + title bar + routed <Outlet /> + the
// in-page audiobook player (ADR-0013). The player lives inside SidebarInset (the
// content column, right of the sidebar) so it overlays content, never the sidebar
// — the bounding the retired WebContentsView used to do via content-rect IPC.
// ActiveDownloadsProvider owns the sole getDownloads + onDownloadProgress session
// subscription; Island / Downloads / Search are views over that store.
// ShellScrollProvider exposes the main overflow scroller so routes do not call
// window.scrollTo (the window is not the scrolling element).
function ShellInner() {
  const { active } = usePlayer();
  const { mainRef } = useShellScroll();
  return (
    <SidebarProvider>
      <TitlebarSync />
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:z-50 focus-visible:p-4 focus-visible:bg-background focus-visible:text-foreground focus-visible:rounded-md"
      >
        Skip to main content
      </a>
      <AppSidebar />
      {/* relative: positioning context for the in-page player overlay. */}
      <SidebarInset className="relative">
        <UpdateBanner />
        <AppHeader />
        <main
          id="main-content"
          ref={(node) => {
            mainRef.current = node;
          }}
          className="surface-content flex-1 overflow-auto p-4 md:p-6"
          style={active ? { paddingBottom: 72 } : undefined}
        >
          <Outlet />
        </main>
        <InPagePlayer />
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  );
}

export default function AppShell() {
  return (
    <PlayerProvider>
      <ActiveDownloadsProvider>
        <ShellScrollProvider>
          <ShellInner />
        </ShellScrollProvider>
      </ActiveDownloadsProvider>
    </PlayerProvider>
  );
}
