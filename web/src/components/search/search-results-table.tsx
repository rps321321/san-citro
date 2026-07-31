"use client";

import type { RefObject } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BookResultRow,
  type BookDownloadUiState,
} from "@/components/search/book-result-row";
import type { BookRecord, SearchResponse } from "@/types";
import { cn } from "@/lib/utils";

export interface SearchResultsTableProps {
  data: SearchResponse;
  resultsStale: boolean;
  resultsHeadingRef: RefObject<HTMLDivElement | null>;
  getDownloadState: (book: BookRecord) => BookDownloadUiState;
  onDownload: (book: BookRecord) => void;
}

/**
 * Sticky header cells for the shell `#main-content` scroller (#59 + #63).
 * Opaque background so rows do not show through while scrolling.
 */
const stickyHeadClass =
  "sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_0_var(--border)]";

/**
 * Results heading + scannable table.
 * Ordering is authoritative at the Search boundary (#61) — no client-side column sort.
 * Column hierarchy (#63): cover · title/author · quiet meta · status.
 *
 * Intentionally omits the default ui/Table overflow wrapper so sticky thead
 * sticks to the shell main scroller rather than a nested scroll container.
 */
export function SearchResultsTable({
  data,
  resultsStale,
  resultsHeadingRef,
  getDownloadState,
  onDownload,
}: SearchResultsTableProps) {
  return (
    <>
      <div
        ref={resultsHeadingRef}
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none"
        aria-live="polite"
      >
        {resultsStale ? (
          <span className="text-destructive">
            Showing previous results — the latest search failed.
          </span>
        ) : (
          <>
            Showing {data.results.length.toLocaleString()} on this page · page {data.page}
            {data.has_next && " · more available"}
          </>
        )}
      </div>

      <div
        className={cn(
          "rounded-lg border bg-background",
          resultsStale && "opacity-50"
        )}
        data-search-results-table
        aria-busy={resultsStale}
      >
        <table
          data-slot="table"
          className="w-full caption-bottom text-sm"
        >
          <TableCaption className="sr-only">Search results</TableCaption>
          <TableHeader data-search-results-header>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(stickyHeadClass, "w-14 px-2")}>
                <span className="sr-only">Cover</span>
              </TableHead>
              <TableHead className={cn(stickyHeadClass, "min-w-0")}>
                Title
              </TableHead>
              <TableHead
                className={cn(
                  stickyHeadClass,
                  "hidden min-w-0 md:table-cell"
                )}
              >
                Details
              </TableHead>
              <TableHead
                className={cn(
                  stickyHeadClass,
                  "w-[8.5rem] px-3 text-right"
                )}
              >
                Status
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.results.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  No results found — try a different term or remove a filter
                </TableCell>
              </TableRow>
            ) : (
              data.results.map((book) => (
                <BookResultRow
                  key={book.md5}
                  book={book}
                  downloadState={getDownloadState(book)}
                  onDownload={onDownload}
                />
              ))
            )}
          </TableBody>
        </table>
      </div>
    </>
  );
}

/** Skeleton loading table — mirrors the 4-col scannable search table (#63). */
export function SearchResultsSkeleton() {
  return (
    <div
      className="rounded-lg border bg-background"
      aria-busy="true"
      aria-label="Loading results"
      data-search-results-skeleton
    >
      <table data-slot="table" className="w-full caption-bottom text-sm">
        <TableCaption className="sr-only">Loading search results…</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-14 px-2">
              <span className="sr-only">Cover</span>
            </TableHead>
            <TableHead>Title</TableHead>
            <TableHead className="hidden md:table-cell">Details</TableHead>
            <TableHead className="w-[8.5rem] px-3 text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell className="w-14 p-2">
                <Skeleton className="h-16 w-12 rounded" />
              </TableCell>
              <TableCell className="py-2.5">
                <Skeleton className="mb-1 h-4 w-48" />
                <Skeleton className="h-3.5 w-28" />
              </TableCell>
              <TableCell className="hidden py-2.5 md:table-cell">
                <Skeleton className="mb-1 h-4 w-16 rounded-full" />
                <Skeleton className="h-3 w-24" />
              </TableCell>
              <TableCell className="py-2 pr-3 text-right">
                <Skeleton className="ml-auto h-7 w-20 rounded-md" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </table>
    </div>
  );
}
