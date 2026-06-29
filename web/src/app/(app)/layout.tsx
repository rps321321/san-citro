"use client";

import { useEffect, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { UpdateBanner } from "@/components/update-banner";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TitlebarSync } from "@/components/titlebar-sync";
import { onPlayerActive, setPlayerContentRect } from "@/lib/api-client";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // RESERVE SPACE: when the persistent audiobook player is active, the player's
  // mini-bar overlays the bottom ~72px of the window. Pad the browsing surface so
  // page content is never hidden behind it.
  const [playerActive, setPlayerActive] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    return onPlayerActive(({ active }) => setPlayerActive(active));
  }, []);

  // Report the body region (right of the sidebar) so the player view is bounded
  // to it and never covers the sidebar. Re-report on resize / sidebar toggle.
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
      <SidebarInset>
        <UpdateBanner />
        <AppHeader />
        <main
          ref={mainRef}
          id="main-content"
          className="flex-1 overflow-auto p-4 md:p-6"
          style={playerActive ? { paddingBottom: 72 } : undefined}
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
