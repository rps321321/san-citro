"use client";

import { SearchIcon } from "lucide-react";

export interface SearchEmptyStateProps {
  onExampleQuery: (query: string) => void;
}

/** Pre-search empty surface. Presentational only. */
export function SearchEmptyState({ onExampleQuery }: SearchEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <SearchIcon className="size-12 mb-4 text-muted-foreground/40" />
      <p className="text-sm">Enter a search query to get started</p>
      <p className="text-xs mt-1">
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
