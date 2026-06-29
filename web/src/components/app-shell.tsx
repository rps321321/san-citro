"use client";

import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router";

import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { UpdateBanner } from "@/components/update-banner";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TitlebarSync } from "@/components/titlebar-sync";
import { onPlayerActive, setPlayerContentRect } from "@/lib/api-client";

// The persistent SPA shell: sidebar + title bar + the routed <Outlet />.
// 2A keeps the WebContentsView player, so the player-active padding and the
// content-rect IPC reporter are preserved here (both removed in 2B).
export default function AppShell() {
  const [playerActive, setPlayerActive] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    return onPlayerActive(({ active }) => setPlayerActive(active));
  }, []);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      setPlayerContentRect({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, []);

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
      {/* The content panel stays opaque (only the sidebar is translucent for
          Mica) so there's no transparent sliver at the sidebar/content seam. */}
      <SidebarInset>
        <UpdateBanner />
        <AppHeader />
        <main
          ref={mainRef}
          id="main-content"
          className="flex-1 overflow-auto p-4 md:p-6"
          style={playerActive ? { paddingBottom: 72 } : undefined}
        >
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
