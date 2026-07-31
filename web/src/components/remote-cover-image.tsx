"use client";

/**
 * Product-owned remote cover image for static Electron export.
 * Owns raw <img>, lazy loading, dimensions, alt, and failed-image fallback.
 * Single narrow @next/next/no-img-element exemption lives here only.
 */

import { useState } from "react";
import { BookOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RemoteCoverImageProps {
  src: string | null | undefined;
  alt: string;
  /** Outer box classes (size, radius, shrink). */
  className?: string;
  /** Classes applied to the <img> (object-fit, blur, scale). */
  imgClassName?: string;
  width?: number;
  height?: number;
  fallbackIconClassName?: string;
  /** When true, render nothing on missing/failed src (e.g. blur backdrop). */
  decorative?: boolean;
  loading?: "lazy" | "eager";
  onError?: () => void;
}

export function RemoteCoverImage({
  src,
  alt,
  className,
  imgClassName,
  width,
  height,
  fallbackIconClassName = "size-5",
  decorative = false,
  loading = "lazy",
  onError,
}: RemoteCoverImageProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    if (decorative) return null;
    return (
      <div
        className={cn(
          "bg-muted flex items-center justify-center",
          className
        )}
        data-cover-placeholder
        aria-hidden="true"
      >
        <BookOpenIcon
          className={cn("text-muted-foreground/40", fallbackIconClassName)}
        />
      </div>
    );
  }

  return (
    <div className={cn("bg-muted overflow-hidden", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote/custom-protocol covers; static Electron export has no image optimizer */}
      <img
        src={src}
        alt={decorative ? "" : alt}
        loading={loading}
        width={width}
        height={height}
        className={cn("h-full w-full object-cover", imgClassName)}
        onError={() => {
          setFailed(true);
          onError?.();
        }}
      />
    </div>
  );
}
