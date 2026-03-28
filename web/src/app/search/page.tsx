"use client";

import { useState, useCallback, useRef } from "react";
import {
  SearchIcon,
  DownloadIcon,
  CheckCircle2Icon,
  LoaderIcon,
  BookOpenIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

import { search, startDownload } from "@/lib/api-client";
import type { SearchParams } from "@/lib/api-client";
import type { BookRecord, SearchResponse } from "@/types";
import { formatFileSize, truncateMd5 } from "@/lib/format";
import {
  trackSearch, trackDownload, trackInteraction, trackError,
  trackFunnelStep, trackFeatureDiscovery, incrementEngagement,
} from "@/lib/telemetry";

const EXTENSIONS = ["", "pdf", "epub", "djvu", "mobi", "azw3", "fb2", "txt", "cbr", "cbz"];
const LANGUAGES = ["", "English", "Russian", "German", "French", "Spanish", "Italian", "Chinese", "Japanese", "Portuguese"];

function BookCover({ coverUrl, isbn13, title }: { coverUrl?: string | null; isbn13?: string; title: string }) {
  const [failed, setFailed] = useState(false);

  // Prefer the cover URL from the scraper; fall back to Open Library by ISBN
  const src = coverUrl || (isbn13 ? `https://covers.openlibrary.org/b/isbn/${isbn13}-S.jpg` : null);

  if (!src || failed) {
    return (
      <div className="w-12 h-16 rounded bg-muted flex items-center justify-center shrink-0">
        <BookOpenIcon className="size-5 text-muted-foreground opacity-40" />
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

function SearchContent() {
  const [query, setQuery] = useState("");
  const [extension, setExtension] = useState("");
  const [language, setLanguage] = useState("");
  const [yearMin, setYearMin] = useState("");
  const [yearMax, setYearMax] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingMd5s, setDownloadingMd5s] = useState<Set<string>>(new Set());
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const doSearch = useCallback(
    async (pageNum: number = 1) => {
      if (!query.trim()) return;

      // NOTE: Do NOT use router.replace() here — in Electron's custom protocol
      // (san-citro://), it triggers a full page reload causing flicker/black screen.

      setIsLoading(true);
      setError(null);

      const currentRequestId = ++requestIdRef.current;

      const params: SearchParams = {
        query: query.trim(),
        page: pageNum,
        per_page: 25,
      };
      if (extension) params.extension = extension;
      if (language) params.language = language;
      if (yearMin) params.year_min = Number(yearMin);
      if (yearMax) params.year_max = Number(yearMax);

      try {
        const t0 = Date.now();
        const result = await search(params);
        const elapsed = Date.now() - t0;
        if (currentRequestId !== requestIdRef.current) return;
        setData(result);
        window.scrollTo({ top: 0 });
        incrementEngagement("searchCount");
        trackFunnelStep("search_to_download", "search_performed", 1, { query: params.query, results: result.total_count });
        trackSearch({
          query: params.query,
          extension: params.extension,
          language: params.language,
          yearMin: params.year_min,
          yearMax: params.year_max,
          resultCount: result.total_count,
          responseTimeMs: elapsed,
          page: pageNum,
        });
      } catch (err) {
        if (currentRequestId !== requestIdRef.current) return;
        const message = err instanceof Error ? err.message : "Search failed";
        setError(message);
        trackError("search_error", message, { component: "search_page" });
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [query, extension, language, yearMin, yearMax]
  );

  // No auto-search — Electron custom protocol doesn't support URL params

  const handleDownload = async (book: BookRecord) => {
    if (downloadingMd5s.has(book.md5)) return; // guard against double-click
    setDownloadError(null);
    setDownloadingMd5s((prev) => new Set(prev).add(book.md5));
    try {
      await startDownload(book.md5, book.title);
      incrementEngagement("downloadStarted");
      trackFunnelStep("search_to_download", "download_clicked", 2, { md5: book.md5 });
      trackFeatureDiscovery("download");
      trackDownload({
        md5: book.md5,
        title: book.title,
        extension: book.extension,
        fileSizeBytes: book.filesize_bytes,
        status: "started",
      });
      // Mark the book as downloaded in the local results so the green check shows
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          results: prev.results.map((b) =>
            b.md5 === book.md5 ? { ...b, is_downloaded: true } : b
          ),
        };
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Download failed";
      setDownloadError(`Failed to download "${book.title || "Untitled"}": ${message}`);
    } finally {
      setDownloadingMd5s((prev) => {
        const next = new Set(prev);
        next.delete(book.md5);
        return next;
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(1);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          Search Anna&apos;s Archive via live scraping
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, author, ISBN..."
              className="pl-9"
              aria-label="Search query"
            />
          </div>
          <Button type="submit" disabled={isLoading || !query.trim()}>
            {isLoading ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <SearchIcon className="size-4" />
            )}
            Search
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="w-40">
            <Select
              value={extension || "__all"}
              onValueChange={(val) => setExtension(!val || val === "__all" ? "" : val)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Extension" />
              </SelectTrigger>
              <SelectContent>
                {EXTENSIONS.map((ext) => (
                  <SelectItem key={ext || "__all"} value={ext || "__all"}>
                    {ext || "All formats"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-40">
            <Select
              value={language || "__all"}
              onValueChange={(val) => setLanguage(!val || val === "__all" ? "" : val)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Language" />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((lang) => (
                  <SelectItem key={lang || "__all"} value={lang || "__all"}>
                    {lang || "All languages"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Input
            type="number"
            value={yearMin}
            onChange={(e) => setYearMin(e.target.value)}
            placeholder="Year from"
            className="w-28"
            aria-label="Year from"
            min={1800}
            max={new Date().getFullYear() + 1}
            step={1}
          />
          <Input
            type="number"
            value={yearMax}
            onChange={(e) => setYearMax(e.target.value)}
            placeholder="Year to"
            className="w-28"
            aria-label="Year to"
            min={1800}
            max={new Date().getFullYear() + 1}
            step={1}
          />
        </div>
      </form>

      {/* Search error */}
      {error && (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Download error */}
      {downloadError && (
        <div className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <span>{downloadError}</span>
          <button
            onClick={() => setDownloadError(null)}
            className="ml-3 shrink-0 text-destructive/70 hover:text-destructive"
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      {/* Results */}
      {data && (
        <>
          <div className="text-sm text-muted-foreground">
            {data.total_count.toLocaleString()} results found (page {data.page}{" "}
            of {data.total_pages})
          </div>

          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">Search results</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16"><span className="sr-only">Cover</span></TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>Year</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.results.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No results found
                    </TableCell>
                  </TableRow>
                ) : (
                  data.results.map((book) => (
                    <TableRow key={book.md5}>
                      <TableCell className="w-16 p-2">
                        <BookCover coverUrl={book.cover_url} isbn13={book.isbn13} title={book.title} />
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <div className="truncate font-medium" title={book.title}>
                          {book.title || "Untitled"}
                        </div>
                        <div
                          className="truncate text-xs text-muted-foreground font-mono"
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
                        <Badge variant="secondary">
                          {book.extension?.toUpperCase() ?? "?"}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatFileSize(book.filesize_bytes)}</TableCell>
                      <TableCell>{book.language || "-"}</TableCell>
                      <TableCell>
                        {book.is_downloaded ? (
                          <CheckCircle2Icon className="size-4 text-green-500" />
                        ) : downloadingMd5s.has(book.md5) ? (
                          <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleDownload(book)}
                            aria-label={`Download ${book.title}`}
                          >
                            <DownloadIcon className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {data.total_pages > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => data.has_prev && doSearch(data.page - 1)}
                    className={
                      !data.has_prev
                        ? "pointer-events-none opacity-50"
                        : "cursor-pointer"
                    }
                    aria-disabled={!data.has_prev}
                  />
                </PaginationItem>
                <PaginationItem>
                  <span className="flex h-8 items-center px-3 text-sm text-muted-foreground">
                    Page {data.page} of {data.total_pages}
                  </span>
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    onClick={() => data.has_next && doSearch(data.page + 1)}
                    className={
                      !data.has_next
                        ? "pointer-events-none opacity-50"
                        : "cursor-pointer"
                    }
                    aria-disabled={!data.has_next}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      )}

      {/* Empty state before searching */}
      {!data && !isLoading && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <SearchIcon className="size-12 mb-4 opacity-30" />
          <p className="text-sm">Enter a search query to get started</p>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return <SearchContent />;
}
