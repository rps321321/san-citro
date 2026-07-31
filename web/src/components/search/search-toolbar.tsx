"use client";

import type { RefObject } from "react";
import { SearchIcon, LoaderIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const SEARCH_EXTENSIONS = [
  "",
  "pdf",
  "epub",
  "djvu",
  "mobi",
  "azw3",
  "fb2",
  "txt",
  "cbr",
  "cbz",
];
export const SEARCH_LANGUAGES = [
  "",
  "English",
  "Russian",
  "German",
  "French",
  "Spanish",
  "Italian",
  "Chinese",
  "Japanese",
  "Portuguese",
];

export interface SearchToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  extension: string;
  language: string;
  isLoading: boolean;
  activeFilterCount: number;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSubmit: (e: React.FormEvent) => void;
  onExtensionChange: (val: string | null) => void;
  onLanguageChange: (val: string | null) => void;
  onClearFilters: () => void;
}

/** Search input, submit, format/language filters, clear. No bridge calls. */
export function SearchToolbar({
  query,
  onQueryChange,
  extension,
  language,
  isLoading,
  activeFilterCount,
  searchInputRef,
  onSubmit,
  onExtensionChange,
  onLanguageChange,
  onClearFilters,
}: SearchToolbarProps) {
  const canSubmit = query.trim().length > 0;

  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Search controls">
      {/* Primary: query + action (~36–40px controls) */}
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="group relative min-w-0 flex-1 rounded-lg transition-shadow duration-200 ease-out focus-within:ring-[3px] focus-within:ring-ring/30"
          data-search-field=""
        >
          <SearchIcon
            data-search-icon=""
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-foreground"
            aria-hidden="true"
          />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Title, author, or ISBN — press / to focus"
            className="h-10 pl-10"
            aria-label="Search query"
            title="Press / to focus search"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          className="shrink-0"
          disabled={isLoading || !canSubmit}
          aria-busy={isLoading || undefined}
          data-search-submit=""
        >
          {/* Invisible longest label pins width so Search ↔ Searching… does not jump. */}
          <span className="inline-grid items-center justify-items-center">
            <span
              className="col-start-1 row-start-1 inline-flex items-center gap-1.5 invisible"
              aria-hidden="true"
            >
              <SearchIcon className="size-4" />
              Searching…
            </span>
            <span className="col-start-1 row-start-1 inline-flex items-center gap-1.5">
              {isLoading ? (
                <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <SearchIcon className="size-4" aria-hidden="true" />
              )}
              {isLoading ? "Searching…" : "Search"}
            </span>
          </span>
        </Button>
      </div>

      {/* Secondary: quieter filter row (default control height, lower emphasis) */}
      <div
        className="flex flex-wrap items-center gap-2 text-muted-foreground"
        data-search-filters=""
      >
        <div className="w-36">
          <Select value={extension || "__all"} onValueChange={onExtensionChange}>
            <SelectTrigger
              className="w-full border-border/60 bg-transparent text-sm text-foreground shadow-none"
              aria-label="Filter by file extension"
              size="default"
            >
              <SelectValue>
                {(value) =>
                  typeof value === "string" && value !== "__all"
                    ? value.toUpperCase()
                    : "All formats"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SEARCH_EXTENSIONS.map((ext) => (
                <SelectItem key={ext || "__all"} value={ext || "__all"}>
                  {ext || "All formats"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-36">
          <Select value={language || "__all"} onValueChange={onLanguageChange}>
            <SelectTrigger
              className="w-full border-border/60 bg-transparent text-sm text-foreground shadow-none"
              aria-label="Filter by language"
              size="default"
            >
              <SelectValue>
                {(value) =>
                  typeof value === "string" && value !== "__all" ? value : "All languages"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SEARCH_LANGUAGES.map((lang) => (
                <SelectItem key={lang || "__all"} value={lang || "__all"}>
                  {lang || "All languages"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {activeFilterCount > 0 && (
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              aria-label={`${activeFilterCount} active filter${activeFilterCount === 1 ? "" : "s"}`}
            >
              {activeFilterCount} active
            </Badge>
            <Button type="button" variant="ghost" size="sm" onClick={onClearFilters}>
              <XIcon className="size-3.5" />
              Clear filters
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}

