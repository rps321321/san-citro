"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  SearchIcon,
  DownloadIcon,
  CheckCircle2Icon,
  LoaderIcon,
  BookOpenIcon,
  XIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/alert";
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
import { SortableHead, toggleSort, type SortState } from "@/components/ui/sortable-head";

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

type SearchSortKey = "title" | "year" | "size";

function compareBooks(a: BookRecord, b: BookRecord, key: SearchSortKey): number {
  switch (key) {
    case "title":
      return (a.title ?? "").localeCompare(b.title ?? "");
    case "year":
      return (a.year ?? 0) - (b.year ?? 0);
    case "size":
      return (a.filesize_bytes ?? 0) - (b.filesize_bytes ?? 0);
  }
}

function BookCover({ coverUrl, isbn13, title }: { coverUrl?: string | null; isbn13?: string; title: string }) {
  const [failed, setFailed] = useState(false);

  // Prefer the cover URL from the scraper; fall back to Open Library by ISBN
  const src = coverUrl || (isbn13 ? `https://covers.openlibrary.org/b/isbn/${isbn13}-S.jpg` : null);

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

function SearchContent() {
  const [query, setQuery] = useState("");
  const [extension, setExtension] = useState("");
  const [language, setLanguage] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingMd5s, setDownloadingMd5s] = useState<Set<string>>(new Set());
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Persists across the download lifecycle (NOT cleared in finally) so the row
  // keeps showing "Queued" after the handoff.
  const [enqueuedMd5s, setEnqueuedMd5s] = useState<Set<string>>(new Set());
  // md5s that reached "completed" live via onDownloadProgress this session.
  const [completedMd5s, setCompletedMd5s] = useState<Set<string>>(new Set());
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  // Set to true when a re-search fails so previously shown results are dimmed/labelled.
  const [resultsStale, setResultsStale] = useState(false);
  // Client-side sort of the current page's results (null = server/scrape order).
  const [sort, setSort] = useState<SortState<SearchSortKey> | null>(null);

  const requestIdRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Focused after pagination so keyboard users don't lose their place.
  const resultsHeadingRef = useRef<HTMLDivElement>(null);

  // Subscribe to live download progress so a row whose md5 reaches "completed"
  // flips to the green check without a re-search (fixes stale is_downloaded).
  useEffect(() => {
    const unsub = window.sanCitro?.onDownloadProgress?.((data) => {
      const items = Array.isArray(data) ? data : [data];
      const done = items.filter((d) => d.status === "completed").map((d) => d.md5);
      if (done.length > 0) {
        setCompletedMd5s((prev) => {
          const next = new Set(prev);
          for (const md5 of done) next.add(md5);
          return next;
        });
      }
    });
    return () => unsub?.();
  }, []);

  // Global shortcut: '/' or Ctrl/Cmd+K focuses the search input. Ignored while
  // typing in another field so '/' stays usable as a literal character.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!ctrlK && !slash) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (slash && typing) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      trackFeatureDiscovery("search_shortcut");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSort = (key: SearchSortKey) => {
    setSort((prev) => toggleSort(prev, key));
    trackInteraction("sort", "search", { key });
  };

  const sortedResults = useMemo(() => {
    if (!data) return [];
    if (!sort) return data.results;
    const sorted = [...data.results].sort((a, b) => compareBooks(a, b, sort.key));
    if (sort.direction === "desc") sorted.reverse();
    return sorted;
  }, [data, sort]);

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
      };
      if (extension) params.extension = extension;
      if (language) params.language = language;

      try {
        const t0 = Date.now();
        const result = await search(params);
        const elapsed = Date.now() - t0;
        if (currentRequestId !== requestIdRef.current) return;
        setData(result);
        setResultsStale(false);
        window.scrollTo({ top: 0 });
        incrementEngagement("searchCount");
        trackFunnelStep("search_to_download", "search_performed", 1, { query: params.query, results: result.total_count });
        trackSearch({
          query: params.query,
          extension: params.extension,
          language: params.language,
          resultCount: result.total_count,
          responseTimeMs: elapsed,
          page: pageNum,
        });
      } catch (err) {
        if (currentRequestId !== requestIdRef.current) return;
        const message = err instanceof Error ? err.message : "Search failed";
        setError(message);
        // Don't present old results as current — mark them stale (dimmed + labelled).
        setResultsStale(true);
        trackError("search_error", message, { component: "search_page" });
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [query, extension, language]
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
      // Do NOT optimistically mark as downloaded — the download was only just
      // enqueued, not completed. Mark it "enqueued" so the row shows a persistent
      // "Queued" badge, and surface a success banner linking to Downloads.
      setEnqueuedMd5s((prev) => new Set(prev).add(book.md5));
      setDownloadSuccess(true);
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

  // When a filter changes and results are already shown, re-run from page 1 so a
  // stale filter never silently persists. doSearch reads the latest state via its
  // deps, so defer to the next tick after setState lands.
  const rerunIfResults = () => {
    if (data) setTimeout(() => doSearch(1), 0);
  };

  const activeFilterCount = (extension ? 1 : 0) + (language ? 1 : 0);

  const handleClearFilters = () => {
    setExtension("");
    setLanguage("");
    trackInteraction("clear_filters", "search");
    if (data) setTimeout(() => doSearch(1), 0);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          Find books, papers, and files from Anna&apos;s Archive
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Title, author, or ISBN — press / to focus"
              className="pl-9"
              aria-label="Search query"
              title="Press / or Ctrl+K to focus search"
            />
          </div>
          <Button type="submit" disabled={isLoading || !query.trim()} aria-busy={isLoading}>
            {isLoading ? (
              <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <SearchIcon className="size-4" aria-hidden="true" />
            )}
            {isLoading ? "Searching…" : "Search"}
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="w-40">
            <Select
              value={extension || "__all"}
              onValueChange={(val) => {
                setExtension(!val || val === "__all" ? "" : val);
                rerunIfResults();
              }}
            >
              <SelectTrigger className="w-full" aria-label="Filter by file extension">
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
              onValueChange={(val) => {
                setLanguage(!val || val === "__all" ? "" : val);
                rerunIfResults();
              }}
            >
              <SelectTrigger className="w-full" aria-label="Filter by language">
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

          {activeFilterCount > 0 && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" aria-label={`${activeFilterCount} active filter${activeFilterCount === 1 ? "" : "s"}`}>
                {activeFilterCount} active
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClearFilters}
              >
                <XIcon className="size-3.5" />
                Clear filters
              </Button>
            </div>
          )}
        </div>
      </form>

      {/* Search error */}
      {error && (
        <Banner
          variant="error"
          onDismiss={() => setError(null)}
        >
          Could not complete the search. Check your connection, then{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => doSearch(data?.page ?? 1)}
          >
            try again
          </button>
          .
        </Banner>
      )}

      {/* Download handoff confirmation */}
      {downloadSuccess && (
        <Banner variant="success" onDismiss={() => setDownloadSuccess(false)}>
          Added to downloads.{" "}
          <a href="/downloads" className="font-medium underline underline-offset-2">
            View downloads
          </a>
        </Banner>
      )}

      {/* Download error */}
      {downloadError && (
        <Banner
          variant="error"
          onDismiss={() => setDownloadError(null)}
        >
          {downloadError} — click the download icon to retry.
        </Banner>
      )}

      {/* Skeleton loading state — 5 rows mirroring the 8-col search table */}
      {isLoading && !data && (
        <div className="rounded-lg border overflow-x-auto" aria-busy="true" aria-label="Loading results">
          <Table>
            <TableCaption className="sr-only">Loading search results…</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16"><span className="sr-only">Cover</span></TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Year</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Language</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
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
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-10 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-6 rounded" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Results */}
      {data && (
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
                Showing {data.results.length.toLocaleString()} on this page · page{" "}
                {data.page}
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
                  <TableHead className="w-16"><span className="sr-only">Cover</span></TableHead>
                  <SortableHead sortKey="title" sort={sort} onSort={handleSort}>Title</SortableHead>
                  <TableHead>Author</TableHead>
                  <SortableHead sortKey="year" sort={sort} onSort={handleSort}>Year</SortableHead>
                  <TableHead>Format</TableHead>
                  <SortableHead sortKey="size" sort={sort} onSort={handleSort}>Size</SortableHead>
                  <TableHead>Language</TableHead>
                  <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedResults.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No results found — try a different term or remove a filter
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedResults.map((book) => (
                    <TableRow key={book.md5}>
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
                        <Badge variant="outline">
                          {book.extension?.toUpperCase() ?? "?"}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatFileSize(book.filesize_bytes)}</TableCell>
                      <TableCell>{book.language || "-"}</TableCell>
                      <TableCell>
                        {book.is_downloaded || completedMd5s.has(book.md5) ? (
                          <span role="img" aria-label="Downloaded" title="Downloaded">
                            <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
                          </span>
                        ) : downloadingMd5s.has(book.md5) ? (
                          <span role="status" aria-label={`Downloading ${book.title}`}>
                            <LoaderIcon className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                            <span className="sr-only">Downloading…</span>
                          </span>
                        ) : enqueuedMd5s.has(book.md5) ? (
                          <Badge variant="outline">Queued</Badge>
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
          {(data.has_prev || data.has_next) && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => {
                      if (data.has_prev) {
                        void doSearch(data.page - 1).then(() =>
                          resultsHeadingRef.current?.focus()
                        );
                      }
                    }}
                    className={
                      !data.has_prev
                        ? "pointer-events-none opacity-50"
                        : "cursor-pointer"
                    }
                    aria-disabled={!data.has_prev}
                    tabIndex={!data.has_prev ? -1 : undefined}
                  />
                </PaginationItem>
                <PaginationItem>
                  <span className="flex h-8 items-center px-3 text-sm text-muted-foreground">
                    Page {data.page}
                  </span>
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    onClick={() => {
                      if (data.has_next) {
                        void doSearch(data.page + 1).then(() =>
                          resultsHeadingRef.current?.focus()
                        );
                      }
                    }}
                    className={
                      !data.has_next
                        ? "pointer-events-none opacity-50"
                        : "cursor-pointer"
                    }
                    aria-disabled={!data.has_next}
                    tabIndex={!data.has_next ? -1 : undefined}
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
          <SearchIcon className="size-12 mb-4 text-muted-foreground/40" />
          <p className="text-sm">Enter a search query to get started</p>
          <p className="text-xs mt-1">
            Try{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => setQuery("The Pragmatic Programmer")}
            >
              The Pragmatic Programmer
            </button>{" "}
            or an author, title, or ISBN
          </p>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return <SearchContent />;
}
