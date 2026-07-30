"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpenIcon,
  LibraryIcon,
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
  HeadphonesIcon,
  Loader2Icon,
  CircleCheckIcon,
  CircleAlertIcon,
  BanIcon,
  PlayIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { listLibrary, onAudiobookStatus } from "@/lib/api-client";
import { usePlayer } from "@/contexts/player-context";
import { DetailSheet } from "@/components/detail-sheet";
import type { LibraryFacets, LibraryItem, LibraryQueryParams } from "@/types";

// ---------------------------------------------------------------------------
// View persistence
// ---------------------------------------------------------------------------

type View = "grid" | "list";
const VIEW_KEY = "library:view";

function readStoredView(): View {
  if (typeof window === "undefined") return "grid";
  return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
}

// ---------------------------------------------------------------------------
// Sort (view state → query param; sorting is owned by the backend)
// ---------------------------------------------------------------------------

type SortKey = "author" | "year" | "title" | "recent";

const SORT_LABELS: Record<SortKey, string> = {
  author: "Author",
  year: "Year",
  title: "Title",
  recent: "Recently added",
};

// Book open behavior now lives in DetailSheet: click a cover → detail → Read/Reveal.

// ---------------------------------------------------------------------------
// Cover — inlined per contract, same fallback pattern as search BookCover
// ---------------------------------------------------------------------------

function Cover({
  coverUrl,
  title,
  size,
}: {
  coverUrl: string | null;
  title: string;
  size: "thumb" | "grid";
}) {
  const [failed, setFailed] = useState(false);
  const box =
    size === "thumb"
      ? "w-12 h-16 rounded shrink-0"
      : "aspect-[2/3] w-full rounded-lg shadow-md ring-1 ring-black/5 transition duration-200 group-hover:shadow-xl group-hover:ring-2 group-hover:ring-primary/50";
  const icon = size === "thumb" ? "size-5" : "size-8";

  if (!coverUrl || failed) {
    return (
      <div className={`${box} bg-muted flex items-center justify-center`}>
        <BookOpenIcon className={`${icon} text-muted-foreground/40`} />
      </div>
    );
  }

  return (
    <div className={`${box} bg-muted overflow-hidden`}>
      <img
        src={coverUrl}
        alt={`Cover of ${title}`}
        loading="lazy"
        className="object-cover w-full h-full"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audiobook presentation helpers
// ---------------------------------------------------------------------------

/** Format a duration in seconds as "Hh Mm" / "Mm" — null/0 renders nothing. */
function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return "< 1m";
}

type StatusVariant = "success" | "warning" | "outline" | "destructive";

interface StatusDisplay {
  label: string;
  variant: StatusVariant;
  spinning: boolean;
}

/** Map a raw audiobook status string to a badge label + variant. */
function statusDisplay(status: string | null): StatusDisplay {
  switch (status) {
    case "ready":
    case "completed":
      return { label: "Ready", variant: "success", spinning: false };
    case "unsupported":
      return { label: "Unsupported", variant: "outline", spinning: false };
    case "error":
    case "failed":
      return { label: "Error", variant: "destructive", spinning: false };
    default:
      // pending / queued / processing / downloading / extracting / null …
      return { label: "Processing…", variant: "warning", spinning: true };
  }
}

function isReady(status: string | null): boolean {
  return status === "ready" || status === "completed";
}

function StatusBadge({ item }: { item: LibraryItem }) {
  const { label, variant, spinning } = statusDisplay(item.status);
  const isError = variant === "destructive";
  const Icon = spinning
    ? Loader2Icon
    : variant === "success"
      ? CircleCheckIcon
      : isError
        ? CircleAlertIcon
        : BanIcon;
  // Dark-glass pill: a translucent scrim + white text keeps the badge legible
  // over ANY cover art (a static badge color blends into bright covers). The
  // status is carried by the icon color, which stays vivid on the dark backing.
  const iconColor =
    variant === "success"
      ? "text-emerald-400"
      : isError
        ? "text-red-400"
        : variant === "warning"
          ? "text-amber-300"
          : "text-zinc-200";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm ring-1 ring-white/15 backdrop-blur-sm"
      title={isError && item.error_message ? item.error_message : undefined}
    >
      <Icon className={`size-3.5 ${iconColor}${spinning ? " animate-spin" : ""}`} />
      {label}
    </span>
  );
}

function AudiobookCard({ item }: { item: LibraryItem }) {
  const { play } = usePlayer();
  const ready = isReady(item.status);
  const title = item.title || "Untitled";
  const duration = formatDuration(item.total_duration_seconds);

  const handleOpen = () => {
    // Launch the in-page audiobook player (mini-bar) for this book.
    if (ready) void play(item.md5).catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={!ready}
      className="group text-left space-y-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
      title={ready ? "Play" : title}
    >
      <div className="relative">
        <div className={ready ? "transition-transform duration-200 group-hover:-translate-y-1" : undefined}>
          <Cover coverUrl={item.cover_url} title={title} size="grid" />
          {ready && (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
              <span className="flex items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs font-medium">
                <PlayIcon className="size-3.5" />
                Play
              </span>
            </div>
          )}
        </div>
        <div className="absolute left-1.5 top-1.5">
          <StatusBadge item={item} />
        </div>
      </div>
      <div>
        <div className="truncate text-sm font-medium leading-snug group-hover:underline group-disabled:no-underline">
          {title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {[
            item.track_count ? `${item.track_count} tracks` : null,
            duration,
            item.container_type ? item.container_type.toUpperCase() : null,
          ]
            .filter(Boolean)
            .join(" · ") || (ready ? "Tap to play" : "Processing…")}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Filter select (options come from backend facets)
// ---------------------------------------------------------------------------

const ALL = "__all";

function FilterSelect({
  label,
  value,
  options,
  onChange,
  format,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  format?: (value: string) => string;
}) {
  if (options.length === 0) return null;
  const display = (v: string) => (format ? format(v) : v);
  return (
    <div className="w-40">
      <Select value={value} onValueChange={(v) => onChange(v ?? ALL)}>
        <SelectTrigger className="w-full" aria-label={`Filter by ${label.toLowerCase()}`}>
          <SelectValue>
            {(v) => (typeof v === "string" && v !== ALL ? display(v) : `All ${label.toLowerCase()}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {display(opt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = "books" | "audiobooks";

const EMPTY_FACETS: LibraryFacets = {
  content_types: [],
  extensions: [],
  languages: [],
};

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>("books");

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [facets, setFacets] = useState<LibraryFacets>(EMPTY_FACETS);
  const [totalEligible, setTotalEligible] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>("grid");
  const [sort, setSort] = useState<SortKey>("author");
  const [category, setCategory] = useState(ALL);
  const [format, setFormat] = useState(ALL);
  const [language, setLanguage] = useState(ALL);
  const [detailItem, setDetailItem] = useState<LibraryItem | null>(null);

  // Read the persisted view after mount to avoid SSR/localStorage mismatch.
  useEffect(() => {
    setView(readStoredView());
  }, []);

  const setAndStoreView = (next: View) => {
    setView(next);
    window.localStorage.setItem(VIEW_KEY, next);
  };

  const load = useCallback(
    async (showSpinner = true) => {
      if (showSpinner) setIsLoading(true);
      const params: LibraryQueryParams = {
        media_kind: tab === "books" ? "books" : "audiobooks",
        sort: tab === "books" ? sort : "recent",
        content_type: tab === "books" && category !== ALL ? category : null,
        extension: tab === "books" && format !== ALL ? format : null,
        language: tab === "books" && language !== ALL ? language : null,
      };
      try {
        const data = await listLibrary(params);
        setItems(data.items);
        setFacets(data.facets);
        setTotalEligible(data.total_eligible);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load library");
      } finally {
        setIsLoading(false);
      }
    },
    [tab, sort, category, format, language]
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Live audiobook status: re-fetch without skeleton so Processing… flips to Ready.
  useEffect(() => {
    if (tab !== "audiobooks") return;
    const unsubscribe = onAudiobookStatus(() => {
      void load(false);
    });
    return unsubscribe;
  }, [tab, load]);

  const switchTab = (next: Tab) => {
    setTab(next);
    // Reset facet filters when leaving books so stale filters don't stick.
    if (next === "audiobooks") {
      setCategory(ALL);
      setFormat(ALL);
      setLanguage(ALL);
    }
  };

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex items-center gap-1 rounded-lg border p-0.5 w-fit">
        <Button
          variant={tab === "books" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => switchTab("books")}
          aria-pressed={tab === "books"}
        >
          <BookOpenIcon className="size-4" />
          Books
        </Button>
        <Button
          variant={tab === "audiobooks" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => switchTab("audiobooks")}
          aria-pressed={tab === "audiobooks"}
        >
          <HeadphonesIcon className="size-4" />
          Audiobooks
        </Button>
      </div>

      {/* Toolbar — sort/filter for books; view toggle for books only (audiobooks stay grid) */}
      {tab === "books" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-44">
              <Select value={sort} onValueChange={(v) => setSort((v as SortKey) ?? "author")}>
                <SelectTrigger className="w-full" aria-label="Sort library">
                  <SelectValue>
                    {(v) => `Sort: ${SORT_LABELS[(v as SortKey) ?? "author"]}`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {SORT_LABELS[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <FilterSelect
              label="Categories"
              value={category}
              options={facets.content_types}
              onChange={setCategory}
            />
            <FilterSelect
              label="Formats"
              value={format}
              options={facets.extensions}
              onChange={setFormat}
              format={(v) => v.toUpperCase()}
            />
            <FilterSelect
              label="Languages"
              value={language}
              options={facets.languages}
              onChange={setLanguage}
            />
          </div>

          {/* View toggle */}
          <div className="flex items-center gap-1 rounded-lg border p-0.5">
            <Button
              variant={view === "grid" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => setAndStoreView("grid")}
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              title="Grid view"
            >
              <LayoutGridIcon className="size-4" />
            </Button>
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => setAndStoreView("list")}
              aria-label="List view"
              aria-pressed={view === "list"}
              title="List view"
            >
              <ListIcon className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 font-medium"
            onClick={() => void load(true)}
          >
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div
          role="status"
          aria-label={tab === "books" ? "Loading library" : "Loading audiobooks"}
          aria-busy="true"
          className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
        >
          <span className="sr-only">
            {tab === "books" ? "Loading library…" : "Loading audiobooks…"}
          </span>
          {Array.from({ length: tab === "books" ? 10 : 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-[2/3] w-full rounded-lg" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : error ? null : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          {tab === "audiobooks" ? (
            <>
              <HeadphonesIcon className="size-12 mb-4 text-muted-foreground/40" />
              <p className="text-sm">No audiobooks yet</p>
              <Button variant="outline" size="sm" className="mt-4" render={<a href="#/search" />}>
                <SearchIcon className="size-3.5" />
                Search for an audiobook to download
              </Button>
            </>
          ) : (
            <>
              <LibraryIcon className="size-12 mb-4 text-muted-foreground/40" />
              <p className="text-sm">
                {totalEligible === 0 ? "No downloads yet" : "No items match these filters"}
              </p>
              {totalEligible === 0 && (
                <Button variant="outline" size="sm" className="mt-4" render={<a href="#/search" />}>
                  <SearchIcon className="size-3.5" />
                  Search for something to download
                </Button>
              )}
            </>
          )}
        </div>
      ) : tab === "audiobooks" ? (
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <AudiobookCard key={item.md5} item={item} />
          ))}
        </div>
      ) : view === "grid" ? (
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item, i) => (
            <button
              key={item.md5}
              type="button"
              onClick={() => setDetailItem(item)}
              style={{ animationDelay: `${Math.min(i, 14) * 30}ms` }}
              className="group text-left space-y-2 rounded-lg outline-none transition-transform duration-200 hover:-translate-y-1 focus-visible:ring-3 focus-visible:ring-ring/50 animate-[card-enter_0.35s_ease-out_both]"
              title={item.title || undefined}
            >
              <div className="relative">
                <Cover coverUrl={item.cover_url} title={item.title || "Untitled"} size="grid" />
                {item.extension && (
                  <Badge
                    variant="secondary"
                    className="absolute bottom-1.5 right-1.5 text-[10px]"
                  >
                    {item.extension.toUpperCase()}
                  </Badge>
                )}
              </div>
              <div>
                <div className="truncate text-sm font-medium leading-snug group-hover:underline">
                  {item.title || "Untitled"}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.author || "Unknown author"}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">Library</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16"><span className="sr-only">Cover</span></TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Year</TableHead>
                <TableHead>Format</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.md5}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open details for ${item.title || "Untitled"}`}
                  className="cursor-pointer outline-none focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
                  onClick={() => setDetailItem(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDetailItem(item);
                    }
                  }}
                >
                  <TableCell className="w-16 p-2">
                    <Cover coverUrl={item.cover_url} title={item.title || "Untitled"} size="thumb" />
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <span className="truncate block font-medium" title={item.title || undefined}>
                      {item.title || "Untitled"}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[10rem]">
                    <span className="truncate block" title={item.author || undefined}>
                      {item.author || "-"}
                    </span>
                  </TableCell>
                  <TableCell>{item.year ?? "-"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{item.extension?.toUpperCase() ?? "?"}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <DetailSheet
        item={detailItem}
        onOpenChange={(open) => {
          if (!open) setDetailItem(null);
        }}
      />
    </div>
  );
}
