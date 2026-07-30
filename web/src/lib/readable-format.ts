/**
 * Readable format policy — which Book Artifact extensions the in-app reader
 * can open (CONTEXT: Readable format; ADR-0014 foliate-js multi-format).
 *
 * Single source of truth for Library detail, Downloads/Activity, and History
 * Read entry points. PDF is deferred (experimental in foliate).
 */

/** Foliate multi-format set. Keep in sync with the reader engine. */
export const READABLE_EXTENSIONS = [
  "epub",
  "mobi",
  "azw3",
  "azw",
  "fb2",
  "fbz",
  "cbz",
] as const;

export type ReadableExtension = (typeof READABLE_EXTENSIONS)[number];

const READABLE_SET: ReadonlySet<string> = new Set(READABLE_EXTENSIONS);

/**
 * Extract a lowercase extension from a bare extension ("epub"), filename
 * ("Title - Author.mobi"), or path ("C:\\...\\book.azw3").
 */
export function extensionOf(extensionOrFilename: string | null | undefined): string {
  if (extensionOrFilename == null) return "";
  const raw = String(extensionOrFilename).trim().toLowerCase();
  if (!raw) return "";
  const base = raw.includes("/") || raw.includes("\\")
    ? (raw.split(/[/\\]/).pop() ?? raw)
    : raw;
  if (!base.includes(".")) return base.replace(/^\./, "");
  return (base.split(".").pop() ?? "").replace(/^\./, "");
}

/**
 * Whether a Book Artifact can open in the in-app reader.
 * Accepts a bare extension or a filename/path.
 */
export function isReadable(extensionOrFilename: string | null | undefined): boolean {
  const ext = extensionOf(extensionOrFilename);
  return ext !== "" && READABLE_SET.has(ext);
}
