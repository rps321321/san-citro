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

// The persistent SPA shell: sidebar + title bar + routed <Outlet /> + the
// in-page audiobook player (ADR-0013). The player lives inside SidebarInset (the
// content column, right of the sidebar) so it overlays content, never the sidebar
// — the bounding the retired WebContentsView used to do via content-rect IPC.
function ShellInner() {
  const { active } = usePlayer();
  return (
    <SidebarProvider>
      <TitlebarSync />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground focus:rounded-md"
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
          className="flex-1 overflow-auto p-4 md:p-6"
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
      <ShellInner />
    </PlayerProvider>
  );
}
