"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  FolderOpenIcon,
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

import {
  listLibrary,
  listAudiobooks,
  onAudiobookStatus,
} from "@/lib/api-client";
import type { Audiobook, LibraryItem } from "@/types";

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
// Sort
// ---------------------------------------------------------------------------

type SortKey = "author" | "year" | "title" | "recent";

const SORT_LABELS: Record<SortKey, string> = {
  author: "Author",
  year: "Year",
  title: "Title",
  recent: "Recently added",
};

function compareItems(a: LibraryItem, b: LibraryItem, key: SortKey): number {
  switch (key) {
    case "author":
      return (a.author ?? "").localeCompare(b.author ?? "");
    case "year":
      // Newest first; missing years sink to the bottom.
      return (b.year ?? -Infinity) - (a.year ?? -Infinity);
    case "title":
      return (a.title ?? "").localeCompare(b.title ?? "");
    case "recent":
      // completed_at desc (most recent first).
      return (b.completed_at ?? "").localeCompare(a.completed_at ?? "");
  }
}

// ---------------------------------------------------------------------------
// Open behavior — mirrors history/page.tsx + downloads/page.tsx
// ---------------------------------------------------------------------------

function openItem(item: LibraryItem): void {
  if (item.filename?.toLowerCase().endsWith(".epub")) {
    sessionStorage.setItem("reader:md5", item.md5);
    sessionStorage.setItem("reader:title", item.title || item.filename || "");
    window.location.href = "/reader";
    return;
  }
  window.sanCitro?.showItemInFolder(item.md5);
}

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
      : "aspect-[2/3] w-full rounded-lg";
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
// Audiobooks
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
function statusDisplay(status: string): StatusDisplay {
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
      // pending / queued / processing / downloading / extracting …
      return { label: "Processing…", variant: "warning", spinning: true };
  }
}

function isReady(status: string): boolean {
  return status === "ready" || status === "completed";
}

function StatusBadge({ book }: { book: Audiobook }) {
  const { label, variant, spinning } = statusDisplay(book.status);
  const isError = variant === "destructive";
  const Icon = spinning
    ? Loader2Icon
    : variant === "success"
      ? CircleCheckIcon
      : isError
        ? CircleAlertIcon
        : BanIcon;
  return (
    <Badge
      variant={variant}
      className="gap-1"
      title={isError && book.error_message ? book.error_message : undefined}
    >
      <Icon className={spinning ? "animate-spin" : undefined} />
      {label}
    </Badge>
  );
}

function AudiobookCard({ book }: { book: Audiobook }) {
  const ready = isReady(book.status);
  const title = book.title || "Untitled";
  const duration = formatDuration(book.total_duration_seconds);

  const handleOpen = () => {
    // No player yet (Phase 4) — reveal the source archive in the file manager.
    if (ready) window.sanCitro?.showItemInFolder(book.md5);
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={!ready}
      className="group text-left space-y-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
      title={ready ? "Show in folder (player coming soon)" : title}
    >
      <div className="relative">
        <Cover coverUrl={book.cover_url} title={title} size="grid" />
        <div className="absolute left-1.5 top-1.5">
          <StatusBadge book={book} />
        </div>
        {ready && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
            <span className="flex items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs font-medium">
              <FolderOpenIcon className="size-3.5" />
              Show in folder
            </span>
          </div>
        )}
      </div>
      <div>
        <div className="truncate text-sm font-medium leading-snug group-hover:underline group-disabled:no-underline">
          {title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {[
            book.track_count ? `${book.track_count} tracks` : null,
            duration,
            book.container_type ? book.container_type.toUpperCase() : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Player coming soon"}
        </div>
      </div>
    </button>
  );
}

function AudiobooksPanel() {
  const [books, setBooks] = useState<Audiobook[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setIsLoading(true);
    try {
      const data = await listAudiobooks();
      setBooks(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audiobooks");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    // Live status: re-fetch (without the loading skeleton) so a Processing…
    // row flips to Ready — with its freshly-populated track_count / duration —
    // as the backend finishes.
    const unsubscribe = onAudiobookStatus(() => {
      void load();
    });
    return unsubscribe;
  }, [load]);

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading audiobooks"
        aria-busy="true"
        className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        <span className="sr-only">Loading audiobooks…</span>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="aspect-[2/3] w-full rounded-lg" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
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
    );
  }

  if (books.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <HeadphonesIcon className="size-12 mb-4 text-muted-foreground/40" />
        <p className="text-sm">No audiobooks yet</p>
        <Button variant="outline" size="sm" className="mt-4" render={<a href="/search" />}>
          <SearchIcon className="size-3.5" />
          Search for an audiobook to download
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {books.map((book) => (
        <AudiobookCard key={book.md5} book={book} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter helpers — only surface options that exist in the data
// ---------------------------------------------------------------------------

const ALL = "__all";

function distinctValues(items: LibraryItem[], key: keyof LibraryItem): string[] {
  const set = new Set<string>();
  for (const item of items) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) set.add(value);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

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

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>("books");

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>("grid");
  const [sort, setSort] = useState<SortKey>("author");
  const [category, setCategory] = useState(ALL);
  const [format, setFormat] = useState(ALL);
  const [language, setLanguage] = useState(ALL);

  // Read the persisted view after mount to avoid SSR/localStorage mismatch.
  useEffect(() => {
    setView(readStoredView());
  }, []);

  const setAndStoreView = (next: View) => {
    setView(next);
    window.localStorage.setItem(VIEW_KEY, next);
  };

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await listLibrary();
      setItems(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load library");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => distinctValues(items, "content_type"), [items]);
  const formats = useMemo(() => distinctValues(items, "extension"), [items]);
  const languages = useMemo(() => distinctValues(items, "language"), [items]);

  const visibleItems = useMemo(() => {
    const filtered = items.filter(
      (item) =>
        (category === ALL || item.content_type === category) &&
        (format === ALL || item.extension === format) &&
        (language === ALL || item.language === language)
    );
    return filtered.sort((a, b) => compareItems(a, b, sort));
  }, [items, sort, category, format, language]);

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex items-center gap-1 rounded-lg border p-0.5 w-fit">
        <Button
          variant={tab === "books" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTab("books")}
          aria-pressed={tab === "books"}
        >
          <BookOpenIcon className="size-4" />
          Books
        </Button>
        <Button
          variant={tab === "audiobooks" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTab("audiobooks")}
          aria-pressed={tab === "audiobooks"}
        >
          <HeadphonesIcon className="size-4" />
          Audiobooks
        </Button>
      </div>

      {tab === "audiobooks" ? (
        <AudiobooksPanel />
      ) : (
        <>
      {/* Toolbar */}
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
            options={categories}
            onChange={setCategory}
          />
          <FilterSelect
            label="Formats"
            value={format}
            options={formats}
            onChange={setFormat}
            format={(v) => v.toUpperCase()}
          />
          <FilterSelect
            label="Languages"
            value={language}
            options={languages}
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

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 font-medium"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div
          role="status"
          aria-label="Loading library"
          aria-busy="true"
          className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
        >
          <span className="sr-only">Loading library…</span>
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-[2/3] w-full rounded-lg" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : error ? null : visibleItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <LibraryIcon className="size-12 mb-4 text-muted-foreground/40" />
          <p className="text-sm">
            {items.length === 0 ? "No downloads yet" : "No items match these filters"}
          </p>
          {items.length === 0 && (
            <Button variant="outline" size="sm" className="mt-4" render={<a href="/search" />}>
              <SearchIcon className="size-3.5" />
              Search for something to download
            </Button>
          )}
        </div>
      ) : view === "grid" ? (
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {visibleItems.map((item) => (
            <button
              key={item.md5}
              type="button"
              onClick={() => openItem(item)}
              className="group text-left space-y-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              title={item.title || undefined}
            >
              <div className="relative">
                <Cover coverUrl={item.cover_url} title={item.title} size="grid" />
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
              {visibleItems.map((item) => (
                <TableRow
                  key={item.md5}
                  className="cursor-pointer"
                  onClick={() => openItem(item)}
                >
                  <TableCell className="w-16 p-2">
                    <Cover coverUrl={item.cover_url} title={item.title} size="thumb" />
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
        </>
      )}
    </div>
  );
}
