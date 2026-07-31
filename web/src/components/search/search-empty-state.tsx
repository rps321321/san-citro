"use client";

import { SearchIcon } from "lucide-react";

export interface SearchEmptyStateProps {
  onExampleQuery: (query: string) => void;
}

/**
 * Pre-search empty surface. Presentational only.
 * Occupies a deliberate content-panel region so the empty state is not a
 * small block stranded at the top of a large blank canvas (#51).
 */
export function SearchEmptyState({ onExampleQuery }: SearchEmptyStateProps) {
  return (
    <div
      data-search-empty-region=""
      className="flex min-h-[min(48vh,22rem)] flex-col items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 text-muted-foreground"
      role="status"
    >
      <SearchIcon className="mb-4 size-12 text-muted-foreground/40" aria-hidden="true" />
      <p className="type-body text-muted-foreground">Enter a search query to get started</p>
      <p className="type-meta mt-1.5 text-center">
        Try{" "}
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2"
          onClick={() => onExampleQuery("The Pragmatic Programmer")}
        >
          The Pragmatic Programmer
        </button>{" "}
        or an author, title, or ISBN
      </p>
    </div>
  );
}
