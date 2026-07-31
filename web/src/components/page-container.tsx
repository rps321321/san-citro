import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Content-width frame for desktop routes. Do not put on Reader / immersive views. */
export type PageContainerSize = "wide" | "narrow";

const sizeClass: Record<PageContainerSize, string> = {
  // ~1152px — Search / table-heavy primary surfaces
  wide: "max-w-6xl",
  // ~672px — form-heavy routes (Settings-style)
  narrow: "max-w-2xl",
};

export interface PageContainerProps {
  children: ReactNode;
  /** Default `wide`. Prefer `narrow` for dense forms. */
  size?: PageContainerSize;
  className?: string;
}

/**
 * Centered content frame with an explicit max-width.
 * Horizontal page padding stays on the shell (`main`); this only bounds width.
 */
export function PageContainer({
  children,
  size = "wide",
  className,
}: PageContainerProps) {
  return (
    <div
      data-page-container={size}
      className={cn("mx-auto w-full min-w-0", sizeClass[size], className)}
    >
      {children}
    </div>
  );
}
