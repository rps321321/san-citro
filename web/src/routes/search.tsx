"use client";

import { useState, useRef, useEffect, useCallback } from "react";

import { SearchToolbar } from "@/components/search/search-toolbar";
import { SearchNotices } from "@/components/search/search-notices";
import { SearchEmptyState } from "@/components/search/search-empty-state";
import {
  SearchResultsTable,
  SearchResultsSkeleton,
} from "@/components/search/search-results-table";
import { SearchPagination } from "@/components/search/search-pagination";
import type { BookDownloadUiState } from "@/components/search/book-result-row";
import { useBookSearch } from "@/hooks/use-book-search";
import { startDownload } from "@/lib/api-client";
import type { BookRecord } from "@/types";
import {
  trackFeatureDiscovery,
  trackFunnelStep,
  incrementEngagement,
} from "@/lib/telemetry";
import { useActiveDownloads } from "@/contexts/active-downloads-context";
import { isLiveActiveStatus } from "@/lib/active-downloads";

function SearchContent() {
  const {
    query,
    setQuery,
    extension,
    language,
    data,
    isLoading,
    error,
    resultsStale,
    activeFilterCount,
    searchInputRef,
    doSearch,
    handleSubmit,
    handleExtensionChange,
    handleLanguageChange,
    handleClearFilters,
    dismissError,
  } = useBookSearch();

  // In-flight startDownload IPC only — live queued/completed come from the shell store.
  const [downloadingMd5s, setDownloadingMd5s] = useState<Set<string>>(new Set());
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  // Focused after pagination so keyboard users don't lose their place.
  const resultsHeadingRef = useRef<HTMLDivElement>(null);

  const {
    downloads: activeDownloads,
    completedThisSession,
    applyProgress: applyDownloadProgress,
  } = useActiveDownloads();

  // Global shortcut: '/' focuses the search input. Ctrl/Cmd+K is owned solely by
  // the Command palette (#29). Ignored while typing in another field so '/' stays
  // usable as a literal character.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!slash) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      trackFeatureDiscovery("search_shortcut");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchInputRef]);

  const handleDownload = async (book: BookRecord) => {
    if (downloadingMd5s.has(book.md5)) return; // guard against double-click
    if (isLiveActiveStatus(activeDownloads.get(book.md5)?.status ?? "")) return;
    setDownloadError(null);
    setDownloadingMd5s((prev) => new Set(prev).add(book.md5));
    try {
      const status = await startDownload(book.md5, book.title, {
        author: book.author,
        year: book.year,
        extension: book.extension,
        content_type: book.content_type,
        language: book.language,
        publisher: book.publisher,
        cover_url: book.cover_url,
      });
      incrementEngagement("downloadStarted");
      trackFunnelStep("search_to_download", "download_clicked", 2, { md5: book.md5 });
      trackFeatureDiscovery("download");
      // Feed the startDownload return into the shared store (same apply path as
      // IPC progress) so Queued shows immediately without a second listener.
      if (status?.md5) {
        applyDownloadProgress(status);
      }
      setDownloadSuccess(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      setDownloadError(`Failed to download "${book.title || "Untitled"}": ${message}`);
    } finally {
      setDownloadingMd5s((prev) => {
        const next = new Set(prev);
        next.delete(book.md5);
        return next;
      });
    }
  };

  const getDownloadState = useCallback(
    (book: BookRecord): BookDownloadUiState => {
      const live = activeDownloads.get(book.md5);
      const liveStatus = live?.status;
      const done =
        book.is_downloaded ||
        completedThisSession.has(book.md5) ||
        liveStatus === "completed";
      if (done) return "done";
      if (downloadingMd5s.has(book.md5) || liveStatus === "downloading") {
        return "downloading";
      }
      if (liveStatus === "queued") return "queued";
      return "idle";
    },
    [activeDownloads, completedThisSession, downloadingMd5s]
  );

  // Focus results summary only after a successful page load so a failed re-search
  // that keeps stale results does not jump the shell scroller (#59).
  const goPrev = () => {
    if (!data?.has_prev) return;
    void doSearch(data.page - 1).then((ok) => {
      if (ok) resultsHeadingRef.current?.focus();
    });
  };

  const goNext = () => {
    if (!data?.has_next) return;
    void doSearch(data.page + 1).then((ok) => {
      if (ok) resultsHeadingRef.current?.focus();
    });
  };

  return (
    <div className="space-y-6">
      <SearchToolbar
        query={query}
        onQueryChange={setQuery}
        extension={extension}
        language={language}
        isLoading={isLoading}
        activeFilterCount={activeFilterCount}
        searchInputRef={searchInputRef}
        onSubmit={handleSubmit}
        onExtensionChange={handleExtensionChange}
        onLanguageChange={handleLanguageChange}
        onClearFilters={handleClearFilters}
      />

      <SearchNotices
        error={error}
        onDismissError={dismissError}
        onRetrySearch={() => void doSearch(data?.page ?? 1)}
        downloadSuccess={downloadSuccess}
        onDismissDownloadSuccess={() => setDownloadSuccess(false)}
        downloadError={downloadError}
        onDismissDownloadError={() => setDownloadError(null)}
      />

      {isLoading && !data && <SearchResultsSkeleton />}

      {data && (
        <>
          <SearchResultsTable
            data={data}
            resultsStale={resultsStale}
            resultsHeadingRef={resultsHeadingRef}
            getDownloadState={getDownloadState}
            onDownload={handleDownload}
          />
          <SearchPagination
            page={data.page}
            hasPrev={data.has_prev}
            hasNext={data.has_next}
            onPrev={goPrev}
            onNext={goNext}
          />
        </>
      )}

      {!data && !isLoading && !error && (
        <SearchEmptyState onExampleQuery={setQuery} />
      )}
    </div>
  );
}

export default function SearchPage() {
  return <SearchContent />;
}
