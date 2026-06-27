"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { trackInteraction } from "@/lib/telemetry";
import {
  SearchIcon,
  DownloadIcon,
  ClockIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  BookOpenIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { TextRepel } from "@/components/ui/text-repel";
import { useThemeToggle } from "@/components/ui/skiper-ui/skiper26";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const NAV_ITEMS = [
  { label: "Search", href: "/search", icon: SearchIcon },
  { label: "Downloads", href: "/downloads", icon: DownloadIcon },
  { label: "History", href: "/history", icon: ClockIcon },
  { label: "Settings", href: "/settings", icon: SettingsIcon },
] as const;

export function AppSidebar() {
  // Read pathname via useSyncExternalStore to avoid SSR hydration mismatch
  // without calling setState in an effect. next/navigation hooks are unreliable
  // in Electron's san-citro:// custom protocol. The location never changes
  // without a full reload here, so subscribe is a no-op.
  const pathname = useSyncExternalStore(
    () => () => {},
    () => window.location.pathname,
    () => ""
  );
  const { resolvedTheme } = useTheme();
  const { toggleTheme } = useThemeToggle({ variant: "circle", start: "bottom-left" });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="app-region-drag">
        <div className="flex items-center justify-between gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <a
            href="/search"
            aria-label="San Citro — home"
            className="app-region-no-drag flex items-center gap-2 overflow-hidden group-data-[collapsible=icon]:hidden"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BookOpenIcon className="size-4" />
            </div>
            <TextRepel text="San Citro" className="text-sm font-semibold" radius={70} strength={16} />
          </a>
          <SidebarTrigger className="app-region-no-drag" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                // Home ("/") re-exports the search page, so treat it as /search.
                const normalized = pathname === "/" ? "/search" : pathname;
                const isActive = normalized.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      render={<a href={item.href} aria-current={isActive ? "page" : undefined} />}
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

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-full justify-start gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
                      onClick={() => {
                        trackInteraction("theme_toggle", "sidebar", {
                          theme: resolvedTheme === "dark" ? "light" : "dark",
                        });
                        toggleTheme();
                      }}
                      aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                    >
                      <SunIcon className="size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" aria-hidden="true" />
                      <MoonIcon className="absolute size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" aria-hidden="true" />
                      <span className="group-data-[collapsible=icon]:hidden">
                        {resolvedTheme === "dark" ? "Light mode" : "Dark mode"}
                      </span>
                    </Button>
                  }
                />
                {/* Tooltip label for when sidebar is icon-collapsed and text span is hidden */}
                <TooltipContent side="right">
                  {resolvedTheme === "dark" ? "Light mode" : "Dark mode"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
