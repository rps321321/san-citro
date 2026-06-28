"use client";

import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { UpdateBanner } from "@/components/update-banner";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { onPlayerActive } from "@/lib/api-client";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // RESERVE SPACE: when the persistent audiobook player is active, the player's
  // mini-bar overlays the bottom ~72px of the window. Pad the browsing surface so
  // page content is never hidden behind it.
  const [playerActive, setPlayerActive] = useState(false);

  useEffect(() => {
    return onPlayerActive(({ active }) => setPlayerActive(active));
  }, []);

  return (
    <SidebarProvider>
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
