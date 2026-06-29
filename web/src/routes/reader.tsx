"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  XIcon,
  LoaderIcon,
  BookOpenIcon,
  AlertCircleIcon,
  SunIcon,
  CoffeeIcon,
  MoonIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { readBookFile } from "@/lib/api-client";
import { trackError, trackFeatureDiscovery, trackReadingProgress } from "@/lib/telemetry";

interface TocItem {
  href: string;
  label: string;
}

// epub.js renders the book into an iframe; we drive nav/progress from the
// rendition. The book to open is passed via sessionStorage (the san-citro://
// custom protocol has no URL query params).
type ReadingTheme = "light" | "sepia" | "dark";

const READER_THEMES: Record<ReadingTheme, { bg: string; color: string }> = {
  light: { bg: "#ffffff", color: "#1a1a1a" },
  sepia: { bg: "#f4ecd8", color: "#5b4636" },
  dark: { bg: "#0a0a0a", color: "#e6e6e6" },
};

function applyTheme(
  rendition: { themes: { override: (k: string, v: string, p?: boolean) => void } },
  theme: ReadingTheme
) {
  const t = READER_THEMES[theme];
  rendition.themes.override("color", t.color, true);
  rendition.themes.override("background", t.bg, true);
}

export default function ReaderPage() {
  const viewportRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renditionRef = useRef<any>(null);
  const openedAtRef = useRef(0);
  const lastBucketRef = useRef(-1);
  const lastPctRef = useRef(0);
  const { resolvedTheme } = useTheme();

  // undefined = sessionStorage not read yet; "" / null = nothing selected
  const [md5, setMd5] = useState<string | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [chapter, setChapter] = useState("");
  const [readingTheme, setReadingTheme] = useState<ReadingTheme>("dark");
  const themeInitRef = useRef(false);

  useEffect(() => {
    setMd5(sessionStorage.getItem("reader:md5"));
    setTitle(sessionStorage.getItem("reader:title") ?? "");
  }, []);

  // Sync the reading theme to the app theme once, then the user controls it.
  useEffect(() => {
    if (themeInitRef.current || !resolvedTheme) return;
    themeInitRef.current = true;
    setReadingTheme(resolvedTheme === "dark" ? "dark" : "light");
  }, [resolvedTheme]);

  const prev = useCallback(() => renditionRef.current?.prev(), []);
  const next = useCallback(() => renditionRef.current?.next(), []);

  useEffect(() => {
    if (md5 === undefined) return; // still reading sessionStorage
    if (!md5) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let book: any;

    (async () => {
      try {
        trackFeatureDiscovery("reader");
        const ePub = (await import("epubjs")).default;
        const data = await readBookFile(md5);
        if (cancelled) return;

        book = ePub(data);
        bookRef.current = book;
        const el = viewportRef.current;
        if (!el) return;

        const rendition = book.renderTo(el, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "auto",
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
        applyTheme(rendition, readingTheme);

        await rendition.display();
        if (cancelled) return;
        setIsLoading(false);
        openedAtRef.current = Date.now() / 1000;
        trackReadingProgress({ event: "open", md5, title });

        const nav = await book.loaded.navigation;
        if (!cancelled) {
          const flat: TocItem[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const walk = (items: any[]) =>
            items.forEach((it) => {
              flat.push({ href: it.href, label: (it.label ?? "").trim() || "Untitled section" });
              if (it.subitems?.length) walk(it.subitems);
            });
          walk(nav.toc ?? []);
          setToc(flat);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rendition.on("relocated", (location: any) => {
          if (cancelled) return;
          const pctInt = Math.round((location?.start?.percentage ?? 0) * 100);
          setProgress(pctInt);
          lastPctRef.current = pctInt;
          const href: string | undefined = location?.start?.href;
          const match = href ? book.navigation?.get?.(href) : null;
          if (match?.label) setChapter(match.label.trim());
          // Throttle progress telemetry to one row per 5% bucket.
          const bucket = Math.floor(pctInt / 5);
          if (bucket !== lastBucketRef.current) {
            lastBucketRef.current = bucket;
            trackReadingProgress({
              event: "progress",
              md5,
              progressPercent: pctInt,
              chapter: match?.label?.trim(),
              elapsedSeconds: Math.round(Date.now() / 1000 - openedAtRef.current),
            });
          }
        });

        // Locations enable an accurate percentage; generate in the background.
        book.ready
          .then(() => book.locations.generate(1600))
          .catch(() => {});
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to open book";
        setError(message);
        setIsLoading(false);
        trackError("reader_error", message, { component: "reader_page" });
      }
    })();

    return () => {
      cancelled = true;
      if (openedAtRef.current > 0) {
        trackReadingProgress({
          event: "closed",
          md5,
          progressPercent: lastPctRef.current,
          elapsedSeconds: Math.round(Date.now() / 1000 - openedAtRef.current),
        });
      }
      try {
        book?.destroy();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md5]);

  // Re-apply the reader theme whenever the reading theme changes.
  useEffect(() => {
    if (renditionRef.current) applyTheme(renditionRef.current, readingTheme);
  }, [readingTheme]);

  // Keyboard paging (works even when focus is outside the epub iframe).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keyup", onKey);
    return () => window.removeEventListener("keyup", onKey);
  }, [prev, next]);

  const goTo = (href: string) => {
    renditionRef.current?.display(href);
    setTocOpen(false);
  };

  // Nothing selected — guide the user to open a book.
  if (md5 !== undefined && !md5) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
        <BookOpenIcon className="size-12 mb-4 opacity-30" />
        <p className="text-sm">No book open</p>
        <p className="text-xs mt-1">Open an EPUB from your History or Downloads to start reading.</p>
        <a href="#/history" className="mt-6">
          <Button variant="outline" size="sm">
            <ListIcon className="size-3.5" />
            Go to History
          </Button>
        </a>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <AlertCircleIcon className="size-12 text-destructive mb-4" />
        <h2 className="text-lg font-semibold tracking-tight">Couldn&apos;t open this book</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{error}</p>
        <a href="#/history" className="mt-6">
          <Button variant="outline" size="sm">Back to History</Button>
        </a>
      </div>
    );
  }

  return (
    <div className="relative flex h-[calc(100vh-8rem)] flex-col gap-2">
      {/* Reading surface */}
      <div
        className="relative flex-1 overflow-hidden rounded-lg border"
        style={{ backgroundColor: READER_THEMES[readingTheme].bg }}
      >
        <div ref={viewportRef} className="h-full w-full" />

        {isLoading && (
          <div role="status" className="absolute inset-0 flex items-center justify-center bg-card">
            <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
            <span className="sr-only">Opening book…</span>
          </div>
        )}

        {/* Edge paging zones */}
        {!isLoading && (
          <>
            <button
              type="button"
              onClick={prev}
              aria-label="Previous page"
              className="absolute inset-y-0 left-0 w-12 cursor-w-resize opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
            >
              <ChevronLeftIcon className="absolute left-2 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next page"
              className="absolute inset-y-0 right-0 w-12 cursor-e-resize opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
            >
              <ChevronRightIcon className="absolute right-2 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
            </button>
          </>
        )}

        {/* TOC drawer */}
        {tocOpen && (
          <>
            <div
              className="absolute inset-0 z-10 bg-black/30"
              onClick={() => setTocOpen(false)}
              aria-hidden="true"
            />
            <div className="absolute inset-y-0 left-0 z-20 flex w-72 max-w-[80%] flex-col border-r bg-background shadow-xl">
              <div className="flex items-center justify-between border-b p-3">
                <span className="text-sm font-semibold">Contents</span>
                <Button variant="ghost" size="icon-sm" aria-label="Close contents" onClick={() => setTocOpen(false)}>
                  <XIcon className="size-4" />
                </Button>
              </div>
              <nav className="flex-1 overflow-y-auto p-2">
                {toc.length === 0 ? (
                  <p className="px-2 py-4 text-xs text-muted-foreground">No table of contents.</p>
                ) : (
                  toc.map((item, i) => (
                    <button
                      key={`${item.href}-${i}`}
                      onClick={() => goTo(item.href)}
                      className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                      title={item.label}
                    >
                      {item.label}
                    </button>
                  ))
                )}
              </nav>
            </div>
          </>
        )}
      </div>

      {/* Control bar */}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setTocOpen((v) => !v)} disabled={isLoading}>
          <ListIcon className="size-3.5" />
          Contents
        </Button>

        {/* Reading theme switcher (light / sepia / dark) */}
        <div className="flex items-center gap-0.5 rounded-md border p-0.5">
          {(
            [
              { key: "light", icon: SunIcon, label: "Light" },
              { key: "sepia", icon: CoffeeIcon, label: "Sepia" },
              { key: "dark", icon: MoonIcon, label: "Dark" },
            ] as const
          ).map((t) => (
            <Button
              key={t.key}
              variant="ghost"
              size="icon-sm"
              onClick={() => setReadingTheme(t.key)}
              aria-label={`${t.label} reading theme`}
              aria-pressed={readingTheme === t.key}
              disabled={isLoading}
              className={readingTheme === t.key ? "bg-primary/10 text-primary" : ""}
            >
              <t.icon className="size-3.5" />
            </Button>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-muted-foreground" title={chapter || title}>
            {chapter || title || "Reading"}
          </div>
          <div
            className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Reading progress"
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{progress}%</span>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={prev} aria-label="Previous page" disabled={isLoading}>
            <ChevronLeftIcon className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={next} aria-label="Next page" disabled={isLoading}>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
