"use client";

import type { RefObject } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
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

export interface SearchResultsTableProps {
  data: SearchResponse;
  resultsStale: boolean;
  resultsHeadingRef: RefObject<HTMLDivElement | null>;
  getDownloadState: (book: BookRecord) => BookDownloadUiState;
  onDownload: (book: BookRecord) => void;
}

/**
 * Results heading + table. Ordering is authoritative at the Search boundary
 * (#61) — no client-side column sort of the current page.
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
        className={`rounded-lg border overflow-x-auto${resultsStale ? " opacity-50" : ""}`}
        aria-busy={resultsStale}
      >
        <Table>
          <TableCaption className="sr-only">Search results</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">
                <span className="sr-only">Cover</span>
              </TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Author</TableHead>
              <TableHead>Year</TableHead>
              <TableHead>Format</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Language</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.results.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
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
        </Table>
      </div>
    </>
  );
}

/** Skeleton loading table — 5 rows mirroring the 8-col search table. */
export function SearchResultsSkeleton() {
  return (
    <div
      className="rounded-lg border overflow-x-auto"
      aria-busy="true"
      aria-label="Loading results"
    >
      <Table>
        <TableCaption className="sr-only">Loading search results…</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">
              <span className="sr-only">Cover</span>
            </TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Author</TableHead>
            <TableHead>Year</TableHead>
            <TableHead>Format</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Language</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell className="w-16 p-2">
                <Skeleton className="w-12 h-16 rounded" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-40 mb-1" />
                <Skeleton className="h-3 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-8" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-10 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-12" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-6 rounded" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
