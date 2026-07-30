/**
 * Display name for the File handed to foliate-js (ADR-0014).
 *
 * Foliate detects format from content + extension on the File name. When a
 * Library item has a known extension but empty filename, callers must not
 * fall back to bare md5 — synthesize `base.ext` instead.
 */

import { extensionOf } from "./readable-format";

export type ReaderFileNameInput = {
  md5: string;
  filename?: string | null;
  extension?: string | null;
  title?: string | null;
};

/**
 * Prefer a real filename when present; else if extension is known, synthesize
 * `title.ext` or `md5.ext`. Bare md5 only when extension is unknown.
 */
export function readerFileDisplayName(input: ReaderFileNameInput): string {
  const filename = (input.filename ?? "").trim();
  if (filename) return filename;

  const ext = extensionOf(input.extension);
  if (!ext) return input.md5;

  const base = (input.title ?? "").trim() || input.md5;
  // Avoid double-extension if title already ends with the same ext.
  if (extensionOf(base) === ext && base.includes(".")) return base;
  return `${base}.${ext}`;
}
