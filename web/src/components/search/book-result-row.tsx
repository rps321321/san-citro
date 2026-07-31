"use client";

import { useState } from "react";
import {
  DownloadIcon,
  CheckCircle2Icon,
  LoaderIcon,
  BookOpenIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import type { BookRecord } from "@/types";
import { formatFileSize, truncateMd5 } from "@/lib/format";

export type BookDownloadUiState = "idle" | "queued" | "downloading" | "done";

function BookCover({
  coverUrl,
  isbn13,
  title,
}: {
  coverUrl?: string | null;
  isbn13?: string;
  title: string;
}) {
  const [failed, setFailed] = useState(false);

  // Prefer the cover URL from the scraper; fall back to Open Library by ISBN
  const src =
    coverUrl || (isbn13 ? `https://covers.openlibrary.org/b/isbn/${isbn13}-S.jpg` : null);

  if (!src || failed) {
    return (
      <div className="w-12 h-16 rounded bg-muted flex items-center justify-center shrink-0">
        <BookOpenIcon className="size-5 text-muted-foreground/40" />
      </div>
    );
  }

  return (
    <div className="w-12 h-16 rounded bg-muted overflow-hidden shrink-0">
      <img
        src={src}
        alt={`Cover of ${title}`}
        loading="lazy"
        width={48}
        height={64}
        className="object-cover w-full h-full"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export interface BookResultRowProps {
  book: BookRecord;
  downloadState: BookDownloadUiState;
  onDownload: (book: BookRecord) => void;
}

/**
 * One results-table row. Presentational: no desktop bridge / api-client imports.
 * Download affordance is driven by `downloadState` + `onDownload` from the page.
 */
export function BookResultRow({ book, downloadState, onDownload }: BookResultRowProps) {
  return (
    <TableRow>
      <TableCell className="w-16 p-2">
        <BookCover coverUrl={book.cover_url} isbn13={book.isbn13} title={book.title} />
      </TableCell>
      <TableCell className="max-w-xs">
        <div className="truncate font-medium" title={book.title}>
          {book.title || "Untitled"}
        </div>
        <div
          className="truncate text-xs text-muted-foreground/60 font-mono"
          title={book.md5}
        >
          {truncateMd5(book.md5)}
        </div>
      </TableCell>
      <TableCell className="max-w-[10rem]">
        <span className="truncate block" title={book.author}>
          {book.author || "-"}
        </span>
      </TableCell>
      <TableCell>{book.year ?? "-"}</TableCell>
      <TableCell>
        <Badge variant="outline">{book.extension?.toUpperCase() ?? "?"}</Badge>
      </TableCell>
      <TableCell>{formatFileSize(book.filesize_bytes)}</TableCell>
      <TableCell>{book.language || "-"}</TableCell>
      <TableCell>
        {downloadState === "done" ? (
          <span role="img" aria-label="Downloaded" title="Downloaded">
            <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
          </span>
        ) : downloadState === "downloading" ? (
          <span role="status" aria-label={`Downloading ${book.title}`}>
            <LoaderIcon
              className="size-4 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
            <span className="sr-only">Downloading…</span>
          </span>
        ) : downloadState === "queued" ? (
          <Badge variant="outline">Queued</Badge>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onDownload(book)}
            aria-label={`Download ${book.title}`}
          >
            <DownloadIcon className="size-4" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
