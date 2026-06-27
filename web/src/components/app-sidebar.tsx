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
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";

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
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="San Citro">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <BookOpenIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">San Citro</span>
                <span className="truncate text-xs text-muted-foreground">
                  Desktop
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const isActive = pathname.startsWith(item.href);
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
            <Button
              variant="ghost"
              size="icon"
              className="w-full justify-start gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
              onClick={() => {
                const next = resolvedTheme === "dark" ? "light" : "dark";
                trackInteraction("theme_toggle", "sidebar", { theme: next });
                setTheme(next);
              }}
              aria-label="Toggle theme"
            >
              <SunIcon className="size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
              <MoonIcon className="absolute size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
              <span className="group-data-[collapsible=icon]:hidden">
                Toggle theme
              </span>
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
