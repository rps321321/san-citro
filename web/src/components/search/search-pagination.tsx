"use client";

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

export interface SearchPaginationProps {
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/** Prev/next page controls. Presentational only. */
export function SearchPagination({
  page,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: SearchPaginationProps) {
  if (!hasPrev && !hasNext) return null;

  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            onClick={() => {
              if (hasPrev) onPrev();
            }}
            className={!hasPrev ? "pointer-events-none opacity-50" : "cursor-pointer"}
            aria-disabled={!hasPrev}
            tabIndex={!hasPrev ? -1 : undefined}
          />
        </PaginationItem>
        <PaginationItem>
          <span className="flex h-8 items-center px-3 text-sm text-muted-foreground">
            Page {page}
          </span>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            onClick={() => {
              if (hasNext) onNext();
            }}
            className={!hasNext ? "pointer-events-none opacity-50" : "cursor-pointer"}
            aria-disabled={!hasNext}
            tabIndex={!hasNext ? -1 : undefined}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
