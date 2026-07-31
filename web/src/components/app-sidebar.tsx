"use client";

import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { useTheme } from "next-themes";
import { trackInteraction } from "@/lib/telemetry";
import {
  SearchIcon,
  LibraryIcon,
  ActivityIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useThemeToggle } from "@/components/ui/skiper-ui/skiper26";

const NAV_ITEMS = [
  { label: "Search", href: "/search", icon: SearchIcon },
  { label: "Library", href: "/library", icon: LibraryIcon },
  { label: "Activity", href: "/activity", icon: ActivityIcon },
  { label: "Settings", href: "/settings", icon: SettingsIcon },
] as const;

// Active hierarchy (issue #55 / ADR-0016): citrus left rail + weight + restrained
// fill — identifiable without relying on pale orange fill alone.
const NAV_ACTIVE_CLASS =
  "rounded-md text-sidebar-foreground/80 hover:text-sidebar-accent-foreground " +
  "data-active:bg-primary/10 data-active:font-semibold data-active:text-primary " +
  "data-active:shadow-[inset_3px_0_0_0_var(--sidebar-primary)]";

export function AppSidebar() {
  // HashRouter: useLocation().pathname is the route (/search, /library, …);
  // window.location.pathname would be "/" always (the route lives in the hash).
  const { pathname } = useLocation();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { resolvedTheme } = useTheme();
  const { toggleTheme } = useThemeToggle({ variant: "circle", start: "bottom-left" });
  const isDark = mounted && resolvedTheme === "dark";
  // Explicit action copy — not a passive "current theme" label.
  const themeActionLabel = isDark ? "Switch to light" : "Switch to dark";

  // Flush to the window edge (not floating): DWM window radius clips the
  // glass rail so it matches the app chrome.
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="app-region-drag h-[var(--titlebar-height)] justify-center border-b border-sidebar-border p-0">
        <div className="flex h-full items-center justify-between gap-1 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <Link
            to="/search"
            aria-label="San Citro — home"
            className="app-region-no-drag flex min-w-0 items-center gap-1.5 overflow-hidden group-data-[collapsible=icon]:hidden"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt="San Citro logo"
              width={24}
              height={24}
              className="size-6 shrink-0 rounded-md"
            />
            <span className="truncate text-sm font-semibold tracking-tight">
              San Citro
            </span>
          </Link>
          <SidebarTrigger className="app-region-no-drag shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="py-2">
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                // Root ("/") redirects to /search, so treat it as /search.
                const normalized = pathname === "/" ? "/search" : pathname;
                const isActive = normalized.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      className={NAV_ACTIVE_CLASS}
                      render={
                        <NavLink
                          to={item.href}
                          aria-current={isActive ? "page" : undefined}
                        />
                      }
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Same row geometry as nav; tooltip only when icon-collapsed. */}
            <SidebarMenuButton
              tooltip={themeActionLabel}
              aria-label={themeActionLabel}
              className="relative text-sidebar-foreground/80 hover:text-sidebar-accent-foreground"
              onClick={() => {
                trackInteraction("theme_toggle", "sidebar", {
                  theme: isDark ? "light" : "dark",
                });
                toggleTheme();
              }}
            >
              <span className="relative flex size-4 shrink-0 items-center justify-center">
                <SunIcon
                  className="size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0"
                  aria-hidden="true"
                />
                <MoonIcon
                  className="absolute size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100"
                  aria-hidden="true"
                />
              </span>
              <span>{themeActionLabel}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
