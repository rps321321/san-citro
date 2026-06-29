"use client";

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useTheme } from "next-themes";
import { Command } from "cmdk";
import {
  SearchIcon,
  LibraryIcon,
  ActivityIcon,
  SettingsIcon,
  SunMoonIcon,
} from "lucide-react";

// Ctrl+K command palette (ADR-0011 + grill). A .glass overlay over cmdk's headless
// Command (filtering + keyboard nav). Mac aesthetic, Windows convention: Ctrl+K.
const NAV = [
  { label: "Search", icon: SearchIcon, to: "/search" },
  { label: "Library", icon: LibraryIcon, to: "/library" },
  { label: "Activity", icon: ActivityIcon, to: "/activity" },
  { label: "Settings", icon: SettingsIcon, to: "/settings" },
] as const;

const ITEM =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm transition data-[selected=true]:bg-primary/15 data-[selected=true]:text-primary";
const GROUP =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[18vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="glass w-full max-w-lg overflow-hidden rounded-xl text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <Command loop className="outline-none">
          <div className="flex items-center gap-2 border-b border-border/50 px-4">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <Command.Input
              autoFocus
              placeholder="Type a command…"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Ctrl K
            </kbd>
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
              No commands found.
            </Command.Empty>
            <Command.Group heading="Navigation" className={GROUP}>
              {NAV.map((c) => (
                <Command.Item
                  key={c.to}
                  value={c.label}
                  onSelect={() => run(() => navigate(c.to))}
                  className={ITEM}
                >
                  <c.icon className="size-4" />
                  {c.label}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading="Theme" className={GROUP}>
              <Command.Item
                value="Toggle theme"
                onSelect={() =>
                  run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))
                }
                className={ITEM}
              >
                <SunMoonIcon className="size-4" />
                Toggle theme
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
