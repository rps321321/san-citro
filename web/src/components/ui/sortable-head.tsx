"use client";

import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { TableHead } from "@/components/ui/table";

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * Toggle helper for a single-column sort. Clicking a new column starts ascending;
 * clicking the active column flips direction.
 */
export function toggleSort<K extends string>(
  current: SortState<K> | null,
  key: K
): SortState<K> {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
}

/**
 * A keyboard-operable, accessible table header that sorts its column on click.
 * Renders the active sort direction and exposes aria-sort to assistive tech.
 */
export function SortableHead<K extends string>({
  sortKey,
  sort,
  onSort,
  children,
  className,
}: {
  sortKey: K;
  sort: SortState<K> | null;
  onSort: (key: K) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const isActive = sort?.key === sortKey;
  const ariaSort = isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

  return (
    <TableHead aria-sort={ariaSort} className={cn("p-0", className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex h-10 w-full items-center gap-1 px-2 text-left font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {children}
        {isActive ? (
          sort.direction === "asc" ? (
            <ArrowUpIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <ArrowDownIcon className="size-3.5 text-muted-foreground" />
          )
        ) : (
          <ChevronsUpDownIcon className="size-3.5 text-muted-foreground/40" />
        )}
      </button>
    </TableHead>
  );
}
