"use client";

import { useState, useCallback, useRef } from "react";

import { search } from "@/lib/api-client";
import type { SearchParams } from "@/lib/api-client";
import type { SearchResponse } from "@/types";
import {
  trackSearch,
  trackInteraction,
  trackError,
  trackFunnelStep,
  incrementEngagement,
} from "@/lib/telemetry";

export type SearchFilterOverrides = {
  extension?: string;
  language?: string;
};

/**
 * Owns Search query/filter/page state, request invocation, and stale-response
 * rejection (request-id race). Presentational Search UI reads this only.
 */
export function useBookSearch() {
  const [query, setQuery] = useState("");
  const [extension, setExtension] = useState("");
  const [language, setLanguage] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set to true when a re-search fails so previously shown results are dimmed/labelled.
  const [resultsStale, setResultsStale] = useState(false);

  const requestIdRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Optional filter overrides let filter onChange handlers pass the *committed*
  // values immediately. Calling doSearch after setState without overrides closes
  // over the previous render's extension/language (stale re-scrape bug #27).
  const doSearch = useCallback(
    async (pageNum: number = 1, overrides?: SearchFilterOverrides) => {
      if (!query.trim()) return;

      // NOTE: Do NOT use router.replace() here — in Electron's custom protocol
      // (san-citro://), it triggers a full page reload causing flicker/black screen.

      setIsLoading(true);
      setError(null);

      const currentRequestId = ++requestIdRef.current;

      const resolvedExtension =
        overrides && "extension" in overrides ? (overrides.extension ?? "") : extension;
      const resolvedLanguage =
        overrides && "language" in overrides ? (overrides.language ?? "") : language;

      const params: SearchParams = {
        query: query.trim(),
        page: pageNum,
      };
      if (resolvedExtension) params.extension = resolvedExtension;
      if (resolvedLanguage) params.language = resolvedLanguage;

      try {
        const t0 = Date.now();
        const result = await search(params);
        const elapsed = Date.now() - t0;
        if (currentRequestId !== requestIdRef.current) return;
        setData(result);
        setResultsStale(false);
        window.scrollTo({ top: 0 });
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void doSearch(1);
  };

  // When a filter changes and results are already shown, re-run from page 1 with
  // the *new* filter values passed explicitly (avoids stale doSearch closure).
  const activeFilterCount = (extension ? 1 : 0) + (language ? 1 : 0);

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

  const handleClearFilters = () => {
    setExtension("");
    setLanguage("");
    trackInteraction("clear_filters", "search");
    if (data) void doSearch(1, { extension: "", language: "" });
  };

  const dismissError = () => setError(null);

  return {
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
  };
}
