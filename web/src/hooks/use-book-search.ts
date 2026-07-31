"use client";

import { useState, useCallback, useRef } from "react";

import { search } from "@/lib/api-client";
import type { SearchParams } from "@/lib/api-client";
import { BOOTSTRAP_SEARCH_CAPABILITIES } from "@/lib/search-capabilities";
import type { SearchCapabilities, SearchResponse } from "@/types";
import {
  trackSearch,
  trackInteraction,
  trackError,
  trackFunnelStep,
  incrementEngagement,
} from "@/lib/telemetry";
import { useShellScrollOptional } from "@/contexts/shell-scroll-context";

export type SearchFilterOverrides = {
  extension?: string;
  language?: string;
  sort?: string;
  /** Immediate query (e.g. example chips) so the call does not wait on setState. */
  query?: string;
};

/**
 * Owns Search query/filter/page/sort state, request invocation, and stale-response
 * rejection (request-id race). Presentational Search UI reads this only.
 *
 * Sort is authoritative at the Search boundary (#61): the selected value is sent
 * on every scrape (including pagination). Client-side column reordering is gone.
 */
export function useBookSearch() {
  const [query, setQuery] = useState("");
  const [extension, setExtension] = useState("");
  const [language, setLanguage] = useState("");
  /** Empty string = AA relevance default. */
  const [sort, setSort] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [capabilities, setCapabilities] = useState<SearchCapabilities>(
    BOOTSTRAP_SEARCH_CAPABILITIES
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set to true when a re-search fails so previously shown results are dimmed/labelled.
  const [resultsStale, setResultsStale] = useState(false);

  const requestIdRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Shell `#main-content` is the overflow scroller — never window (#59).
  const shellScroll = useShellScrollOptional();

  // Optional filter/query overrides let callers pass *committed* values
  // immediately. Calling doSearch after setState without overrides closes
  // over the previous render (stale re-scrape bug #27; example chips #57).
  const doSearch = useCallback(
    async (
      pageNum: number = 1,
      overrides?: SearchFilterOverrides
    ): Promise<boolean> => {
      const resolvedQuery =
        overrides && "query" in overrides
          ? (overrides.query ?? "").trim()
          : query.trim();
      if (!resolvedQuery) return false;

      // NOTE: Do NOT use router.replace() here — in Electron's custom protocol
      // (san-citro://), it triggers a full page reload causing flicker/black screen.

      setIsLoading(true);
      setError(null);

      const currentRequestId = ++requestIdRef.current;

      const resolvedExtension =
        overrides && "extension" in overrides ? (overrides.extension ?? "") : extension;
      const resolvedLanguage =
        overrides && "language" in overrides ? (overrides.language ?? "") : language;
      const resolvedSort =
        overrides && "sort" in overrides ? (overrides.sort ?? "") : sort;

      const params: SearchParams = {
        query: resolvedQuery,
        page: pageNum,
      };
      if (resolvedExtension) params.extension = resolvedExtension;
      if (resolvedLanguage) params.language = resolvedLanguage;
      // Always send sort so pagination preserves the authoritative order (#61).
      // Empty string = relevance; bridge omits the AA param for that case.
      if (resolvedSort) params.sort = resolvedSort;

      try {
        const t0 = Date.now();
        const result = await search(params);
        const elapsed = Date.now() - t0;
        if (currentRequestId !== requestIdRef.current) return false;
        setData(result);
        if (result.capabilities) {
          setCapabilities(result.capabilities);
        }
        setResultsStale(false);
        // Instant shell scroll only on success — not on retained stale results.
        shellScroll?.scrollToTop({ behavior: "auto" });
        incrementEngagement("searchCount");
        trackFunnelStep("search_to_download", "search_performed", 1, {
          query: params.query,
          results: result.total_count,
        });
        trackSearch({
          query: params.query,
          extension: params.extension,
          language: params.language,
          resultCount: result.total_count,
          responseTimeMs: elapsed,
          page: pageNum,
        });
        return true;
      } catch (err) {
        if (currentRequestId !== requestIdRef.current) return false;
        const message = err instanceof Error ? err.message : "Search failed";
        setError(message);
        // Don't present old results as current — mark them stale (dimmed + labelled).
        // Do not scroll: user should stay put with the previous results (#59).
        setResultsStale(true);
        trackError("search_error", message, { component: "search_page" });
        return false;
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [query, extension, language, sort, shellScroll]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void doSearch(1);
  };

  // When a filter changes and results are already shown, re-run from page 1 with
  // the *new* filter values passed explicitly (avoids stale doSearch closure).
  const activeFilterCount =
    (extension ? 1 : 0) + (language ? 1 : 0) + (sort ? 1 : 0);

  const handleExtensionChange = (val: string | null) => {
    const next = !val || val === "__all" ? "" : val;
    setExtension(next);
    if (data) void doSearch(1, { extension: next });
  };

  const handleLanguageChange = (val: string | null) => {
    const next = !val || val === "__all" ? "" : val;
    setLanguage(next);
    if (data) void doSearch(1, { language: next });
  };

  const handleSortChange = (val: string | null) => {
    // Select uses "__relevance" for empty AA default (Radix dislikes empty values).
    const next = !val || val === "__relevance" ? "" : val;
    setSort(next);
    trackInteraction("sort", "search", { sort: next || "relevance" });
    if (data) void doSearch(1, { sort: next });
  };

  const handleClearFilters = () => {
    setExtension("");
    setLanguage("");
    setSort("");
    trackInteraction("clear_filters", "search");
    if (data) void doSearch(1, { extension: "", language: "", sort: "" });
  };

  const dismissError = () => setError(null);

  return {
    query,
    setQuery,
    extension,
    language,
    sort,
    capabilities,
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
    handleSortChange,
    handleClearFilters,
    dismissError,
  };
}
