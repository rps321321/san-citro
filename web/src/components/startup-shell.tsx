/**
 * Shell-shaped fallback painted while the HashRouter client gate is closed.
 * Mirrors AppShell geometry (sidebar rail + title-bar strip + opaque content)
 * so startup never shows a featureless blank frame (issue #62).
 */
import { Skeleton } from "@/components/ui/skeleton";

export function StartupShell() {
  return (
    <div
      data-startup-shell=""
      className="flex h-svh w-full bg-transparent"
      role="status"
      aria-busy="true"
      aria-label="Loading San Citro"
    >
      {/* Sidebar rail — same 14rem width as SidebarProvider SIDEBAR_WIDTH (issue #55). */}
      <aside
        className="sidebar-glass hidden h-full w-[14rem] shrink-0 flex-col border-r border-sidebar-border md:flex"
        aria-hidden="true"
      >
        <div className="flex h-[var(--titlebar-height)] items-center gap-1.5 border-b border-sidebar-border px-2">
          <Skeleton className="size-6 shrink-0 rounded-md" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-8 w-full" />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Title-bar strip geometry matches AppHeader (issue #53). */}
        <header
          className="relative flex h-[var(--titlebar-height)] shrink-0 items-center bg-[var(--titlebar-bg)] text-[var(--titlebar-symbol)]"
          data-titlebar=""
          aria-hidden="true"
        >
          <div className="flex-1" />
          <div
            className="shrink-0 self-stretch"
            style={{ width: "var(--titlebar-overlay-width)" }}
          />
        </header>

        <main className="surface-content flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <div
            className="size-8 animate-spin rounded-full border-2 border-muted border-t-primary"
            aria-hidden="true"
          />
          <p className="type-meta text-muted-foreground">Loading library…</p>
        </main>
      </div>
    </div>
  );
}
