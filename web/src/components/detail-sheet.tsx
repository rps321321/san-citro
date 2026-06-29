"use client";

import { BookOpenIcon, FolderOpenIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import type { LibraryItem } from "@/types";

// Book detail sheet (grill / ADR-0011): click a library cover → a slide-in panel
// with cover + metadata + actions. Conservative build — the default Sheet (no
// glass, no cover-morph) to avoid the glass-killer trap on base-ui's slide
// transform; the citrus accent comes from the primary Read button. The morph +
// glass + lazy OpenLibrary enrichment are follow-ups.

function fmtSize(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const META: { key: keyof LibraryItem; label: string; fmt?: (v: unknown) => string }[] = [
  { key: "year", label: "Year" },
  { key: "extension", label: "Format", fmt: (v) => String(v).toUpperCase() },
  { key: "language", label: "Language" },
  { key: "publisher", label: "Publisher" },
];

export function DetailSheet({
  item,
  onOpenChange,
}: {
  item: LibraryItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  // Readable in-app via foliate-js (ADR-0014): epub/mobi/azw3/fb2/cbz.
  const ext = (item?.extension || item?.filename?.split(".").pop() || "").toLowerCase();
  const isReadable = ["epub", "mobi", "azw3", "azw", "fb2", "fbz", "cbz"].includes(ext);
  const size = fmtSize(item?.filesize_bytes ?? null);

  const read = () => {
    if (!item) return;
    sessionStorage.setItem("reader:md5", item.md5);
    sessionStorage.setItem("reader:title", item.title || item.filename || "");
    sessionStorage.setItem("reader:filename", item.filename ?? "");
    window.location.hash = "#/reader";
    onOpenChange(false);
  };
  const reveal = () => {
    if (item) window.sanCitro?.showItemInFolder(item.md5);
  };

  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        {item && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8 leading-snug">{item.title || "Untitled"}</SheetTitle>
              <SheetDescription>{item.author || "Unknown author"}</SheetDescription>
            </SheetHeader>

            <div className="flex flex-col items-center gap-5 overflow-y-auto px-4 pb-4">
              <div className="aspect-[2/3] w-44 shrink-0 overflow-hidden rounded-lg bg-muted shadow-lg ring-1 ring-black/5">
                {item.cover_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.cover_url} alt={`Cover of ${item.title}`} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <BookOpenIcon className="size-10 text-muted-foreground/40" />
                  </div>
                )}
              </div>

              <dl className="grid w-full grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                {META.map(({ key, label, fmt }) => {
                  const v = item[key];
                  if (v === null || v === undefined || v === "") return null;
                  return (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="truncate">{fmt ? fmt(v) : String(v)}</dd>
                    </div>
                  );
                })}
                {size && (
                  <div className="contents">
                    <dt className="text-muted-foreground">Size</dt>
                    <dd>{size}</dd>
                  </div>
                )}
              </dl>
            </div>

            <SheetFooter>
              {isReadable && (
                <Button onClick={read}>
                  <BookOpenIcon />
                  Read
                </Button>
              )}
              <Button variant="outline" onClick={reveal}>
                <FolderOpenIcon />
                Reveal in folder
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
