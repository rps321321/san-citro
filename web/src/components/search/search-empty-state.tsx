"use client";

import { BookOpenIcon, DownloadIcon, SearchIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { BOOTSTRAP_SEARCH_CAPABILITIES } from "@/lib/search-capabilities";
import { cn } from "@/lib/utils";

/** Example queries shown as one-action chips. Kept local (no remote personalization). */
export const SEARCH_EXAMPLE_QUERIES = [
  { label: "The Pragmatic Programmer", query: "The Pragmatic Programmer" },
  { label: "James Clear", query: "James Clear" },
  { label: "9780735211292", query: "9780735211292" },
  { label: "Meditations", query: "Meditations" },
] as const;

/** Format values from bootstrap capabilities (mirrors Search format filters). */
export const SEARCH_FORMAT_HINTS = BOOTSTRAP_SEARCH_CAPABILITIES.extensions.map(
  (ext) => ext.value
);

export interface SearchEmptyStateProps {
  /** Run an example immediately (fill query + search). */
  onExampleQuery: (query: string) => void;
  /** Show Open Library when local library has items. */
  showLibrary?: boolean;
  /** Show Open Activity when downloads or history exist. */
  showActivity?: boolean;
}

/**
 * Pre-search welcome surface (#57). Presentational only.
 * Occupies a deliberate content-panel region so the empty state is not a
 * small block stranded at the top of a large blank canvas (#51).
 */
export function SearchEmptyState({
  onExampleQuery,
  showLibrary = false,
  showActivity = false,
}: SearchEmptyStateProps) {
  const formatHint = SEARCH_FORMAT_HINTS.map((ext) => ext.toUpperCase()).join(
    " · "
  );
  const showLocalShortcuts = showLibrary || showActivity;

  return (
    <div
      data-search-empty-region=""
      className="flex min-h-[min(48vh,22rem)] flex-col items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-muted-foreground"
      role="region"
      aria-label="Search tips"
    >
      <SearchIcon
        className="mb-3 size-10 text-muted-foreground/40"
        aria-hidden="true"
      />

      <p className="type-body text-center text-muted-foreground">
        Search by title, author, ISBN, or identifier.
      </p>
      <p className="type-meta mt-1 max-w-md text-center">
        Type a query above, or try an example — each runs a search immediately.
      </p>

      <ul
        className="mt-4 flex max-w-lg flex-wrap items-center justify-center gap-2"
        aria-label="Example searches"
      >
        {SEARCH_EXAMPLE_QUERIES.map((example) => (
          <li key={example.query}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="font-normal"
              onClick={() => onExampleQuery(example.query)}
            >
              {example.label}
            </Button>
          </li>
        ))}
      </ul>

      <p className="type-meta mt-4 max-w-lg text-center" data-search-format-hint="">
        Formats: {formatHint}
      </p>

      {showLocalShortcuts && (
        <nav
          className="mt-5 flex flex-wrap items-center justify-center gap-2"
          aria-label="Local library shortcuts"
        >
          {showLibrary && (
            <a
              href="#/library"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              <BookOpenIcon className="size-3.5" aria-hidden="true" />
              Open Library
            </a>
          )}
          {showActivity && (
            <a
              href="#/activity"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            >
              <DownloadIcon className="size-3.5" aria-hidden="true" />
              Open Activity
            </a>
          )}
        </nav>
      )}
    </div>
  );
}
