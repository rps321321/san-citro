"use client";

import {
  DownloadIcon,
  CheckCircle2Icon,
  LoaderIcon,
  ClockIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { RemoteCoverImage } from "@/components/remote-cover-image";
import type { BookRecord } from "@/types";
import { formatFileSize, truncateMd5 } from "@/lib/format";
import { cn } from "@/lib/utils";

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
  // Prefer the cover URL from the scraper; fall back to Open Library by ISBN
  const src =
    coverUrl || (isbn13 ? `https://covers.openlibrary.org/b/isbn/${isbn13}-S.jpg` : null);

  return (
    <RemoteCoverImage
      src={src}
      alt={`Cover of ${title}`}
      className="h-16 w-12 shrink-0 rounded"
      width={48}
      height={64}
      fallbackIconClassName="size-5"
    />
  );
}

/** Build muted meta pieces; empty slots become stable placeholders. */
export function buildBookMetaParts(book: BookRecord): {
  formatLabel: string;
  yearLabel: string;
  sizeLabel: string;
  languageLabel: string;
  /** Full line for tooltips / combined narrow meta */
  combined: string;
} {
  const formatLabel = book.extension?.trim()
    ? book.extension.toUpperCase()
    : "—";
  const yearLabel =
    book.year != null && Number.isFinite(book.year) ? String(book.year) : "—";
  const sizeLabel = formatFileSize(book.filesize_bytes);
  const languageLabel = book.language?.trim() || "—";
  const combined = [formatLabel, yearLabel, sizeLabel, languageLabel].join(" · ");
  return { formatLabel, yearLabel, sizeLabel, languageLabel, combined };
}

function DownloadStatusCell({
  book,
  downloadState,
  onDownload,
}: {
  book: BookRecord;
  downloadState: BookDownloadUiState;
  onDownload: (book: BookRecord) => void;
}) {
  const title = book.title?.trim() || "Untitled";

  if (downloadState === "done") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        data-download-state="done"
        role="img"
        aria-label="Downloaded"
        title="Downloaded"
      >
        <CheckCircle2Icon className="size-3.5 text-success" aria-hidden="true" />
        <span>Downloaded</span>
      </span>
    );
  }

  if (downloadState === "downloading") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        data-download-state="downloading"
        role="status"
        aria-label={`Downloading ${title}`}
        title="Downloading"
      >
        <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
        <span>Downloading</span>
      </span>
    );
  }

  if (downloadState === "queued") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        data-download-state="queued"
        role="status"
        aria-label={`Queued ${title}`}
        title="Queued"
      >
        <ClockIcon className="size-3.5" aria-hidden="true" />
        <span>Queued</span>
      </span>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      data-download-state="available"
      onClick={() => onDownload(book)}
      aria-label={`Download ${title}`}
      title={`Download ${title}`}
    >
      <DownloadIcon className="size-3.5" data-icon="inline-start" />
      Download
    </Button>
  );
}

export interface BookResultRowProps {
  book: BookRecord;
  downloadState: BookDownloadUiState;
  onDownload: (book: BookRecord) => void;
}

/**
 * One results-table row. Presentational: no desktop bridge / api-client imports.
 * Hierarchy: cover + title/author primary; year/format/size/language quiet meta;
 * download state stable rightmost (#63).
 */
export function BookResultRow({ book, downloadState, onDownload }: BookResultRowProps) {
  const title = book.title?.trim() || "Untitled";
  const author = book.author?.trim() || "Unknown author";
  const meta = buildBookMetaParts(book);
  const md5Short = truncateMd5(book.md5);
  const bookTooltip = [title, author, meta.combined, md5Short && `md5 ${md5Short}`]
    .filter(Boolean)
    .join(" — ");

  return (
    <TableRow
      data-search-result-row
      className={cn(
        "group/row outline-none",
        "hover:bg-muted/40",
        "focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      )}
      tabIndex={0}
      title={bookTooltip}
    >
      {/* Cover — primary visual anchor */}
      <TableCell className="w-14 p-2 align-middle">
        <BookCover coverUrl={book.cover_url} isbn13={book.isbn13} title={title} />
      </TableCell>

      {/* Title + author — primary reading path */}
      <TableCell className="min-w-0 max-w-md py-2.5 align-middle">
        <div className="min-w-0 space-y-0.5">
          <div className="truncate text-sm font-medium text-foreground" data-result-title>
            {title}
          </div>
          <div className="truncate text-sm text-muted-foreground" data-result-author>
            {author}
          </div>
          {/* Combined quiet meta when dedicated meta column pieces collapse */}
          <div
            className="truncate type-meta text-muted-foreground/80 md:hidden"
            data-result-meta-inline
          >
            <span className="font-medium text-muted-foreground">{meta.formatLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>{meta.yearLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>{meta.sizeLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>{meta.languageLabel}</span>
          </div>
        </div>
      </TableCell>

      {/* Quiet meta column — de-emphasized vs title/author; collapses before Status */}
      <TableCell
        className="hidden min-w-0 max-w-[14rem] py-2.5 align-middle md:table-cell"
        data-result-meta
        title={meta.combined}
      >
        <div className="flex min-w-0 flex-col gap-0.5 type-meta">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge
              variant="outline"
              className="shrink-0 px-1.5 py-0 text-[0.65rem] font-normal text-muted-foreground"
            >
              {meta.formatLabel}
            </Badge>
            <span className="truncate tabular-nums text-muted-foreground" data-result-year>
              {meta.yearLabel}
            </span>
          </div>
          {/* Size/language hide first at narrower widths; full string stays in title */}
          <div className="truncate text-muted-foreground/80">
            <span data-result-size className="hidden lg:inline">
              {meta.sizeLabel}
            </span>
            <span className="hidden xl:inline" aria-hidden="true">
              {" · "}
            </span>
            <span data-result-language className="hidden xl:inline">
              {meta.languageLabel}
            </span>
          </div>
        </div>
      </TableCell>

      {/* Status — stable rightmost; icon + text so states are not color-only */}
      <TableCell className="w-[8.5rem] py-2 pl-2 pr-3 text-right align-middle">
        <div className="flex justify-end">
          <DownloadStatusCell
            book={book}
            downloadState={downloadState}
            onDownload={onDownload}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}
