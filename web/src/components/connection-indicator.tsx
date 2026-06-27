"use client";

import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/lib/use-sse";

const PRESENTATION: Record<
  ConnectionState,
  { dot: string; label: string }
> = {
  connecting: { dot: "bg-muted-foreground/50 animate-pulse", label: "Connecting…" },
  connected: { dot: "bg-success", label: "Connected" },
  disconnected: { dot: "bg-destructive", label: "Disconnected" },
};

/** Shared dot + label for download-stream link health (Downloads header + app header). */
export function ConnectionIndicator({
  connection,
  className,
}: {
  connection: ConnectionState;
  className?: string;
}) {
  const { dot, label } = PRESENTATION[connection];
  return (
    <div
      className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
      role="status"
      aria-label={`Connection status: ${label}`}
    >
      <span className={cn("size-2 rounded-full", dot)} />
      {label}
    </div>
  );
}
