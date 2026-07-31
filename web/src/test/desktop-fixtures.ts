/**
 * Deterministic desktop layout fixtures (issue #64).
 *
 * Supplies Search results, Active downloads, and theme/viewport constants without
 * real Electron/Python/network calls. Values are fixed so progress/timestamps
 * can be masked in baselines.
 */

import type { BookRecord, DownloadStatus, SearchResponse } from "@/types";
import {
  TITLEBAR_HEIGHT_PX,
  TITLEBAR_OVERLAY_WIDTH_PX,
} from "@/lib/titlebar";

/** Electron BrowserWindow default (main.ts). */
export const DESKTOP_VIEWPORT_DEFAULT = {
  width: 1360,
  height: 920,
} as const;

/** Electron BrowserWindow minimum (main.ts). */
export const DESKTOP_VIEWPORT_MINIMUM = {
  width: 1120,
  height: 840,
} as const;

export type DesktopViewportName = "default" | "minimum";

export const DESKTOP_VIEWPORTS = {
  default: DESKTOP_VIEWPORT_DEFAULT,
  minimum: DESKTOP_VIEWPORT_MINIMUM,
} as const;

/** Documented structural tolerance for layout fingerprints (not pixel bitmaps). */
export const LAYOUT_BASELINE_TOLERANCE = {
  /** Exact match on structural fingerprint keys; no soft float compare. */
  mode: "exact-structure" as const,
  note:
    "jsdom has no real box layout — gates are structural (DOM order, tokens, " +
    "visibility, data-state). Packaged native title-bar hover is manual checklist.",
};

export const TITLEBAR_CONTRACT = {
  heightPx: TITLEBAR_HEIGHT_PX,
  overlayWidthPx: TITLEBAR_OVERLAY_WIDTH_PX,
  heightCssVar: "var(--titlebar-height)",
  overlayWidthCssVar: "var(--titlebar-overlay-width)",
} as const;

/** Stable MD5s — never random in fixtures. */
export const FIXTURE_BOOK_MD5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FIXTURE_BOOK_MD5_2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const FIXTURE_DOWNLOAD_MD5 = "cccccccccccccccccccccccccccccccc";

export const FIXTURE_BOOKS: BookRecord[] = [
  {
    title: "Deterministic Layout Book",
    author: "Fixture Author",
    year: 2020,
    extension: "epub",
    md5: FIXTURE_BOOK_MD5,
    language: "English",
    filesize_bytes: 1_024_000,
    publisher: "Fixture Press",
    isbn13: "9780000000001",
    cover_url: null,
    content_type: "non-fiction",
    is_downloaded: false,
  },
  {
    title: "Second Layout Book",
    author: "Another Author",
    year: 2018,
    extension: "pdf",
    md5: FIXTURE_BOOK_MD5_2,
    language: "English",
    filesize_bytes: 2_048_000,
    publisher: "Fixture Press",
    isbn13: "9780000000002",
    cover_url: null,
    content_type: "fiction",
    is_downloaded: false,
  },
];

export const FIXTURE_SEARCH_EMPTY: SearchResponse = {
  results: [],
  total_count: 0,
  page: 1,
  has_next: false,
  has_prev: false,
  sort: "",
  capabilities: {
    sorts: [
      { value: "", label: "Relevance" },
      { value: "newest", label: "Newest" },
    ],
    extensions: [
      { value: "epub", label: "EPUB" },
      { value: "pdf", label: "PDF" },
    ],
    languages: [{ value: "English", label: "English" }],
  },
};

export const FIXTURE_SEARCH_RESULTS: SearchResponse = {
  results: FIXTURE_BOOKS,
  total_count: FIXTURE_BOOKS.length,
  page: 1,
  has_next: false,
  has_prev: false,
  sort: "",
  capabilities: FIXTURE_SEARCH_EMPTY.capabilities,
};

/**
 * Active download with fixed progress/timestamps (mask these in any free text).
 * Status Island should show "Downloading…" when hydrated.
 */
export const FIXTURE_ACTIVE_DOWNLOAD: DownloadStatus = {
  md5: FIXTURE_DOWNLOAD_MD5,
  title: "Deterministic Layout Book",
  status: "downloading",
  progress_percent: 42,
  total_bytes: 1_024_000,
  downloaded_bytes: 430_080,
  error: null,
  filename: "deterministic-layout-book.epub",
  file_path: null,
  started_at: 1_700_000_000,
  terminal_at: null,
  terminal_expires_at: null,
};

/** Patterns stripped from structural dumps so baselines stay stable. */
export const DYNAMIC_VALUE_MASKS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /\d{1,3}%/g, replace: "[PCT]" },
  { pattern: /\b\d{1,3}(?:\.\d+)?\s*(?:KB|MB|GB|B)\b/gi, replace: "[SIZE]" },
  { pattern: /\b1[6-9]\d{8}\b/g, replace: "[TS]" },
  { pattern: /\b20\d{2}-\d{2}-\d{2}T[\d:.Z+-]+\b/g, replace: "[ISO]" },
];

export function maskDynamicText(text: string): string {
  let out = text;
  for (const { pattern, replace } of DYNAMIC_VALUE_MASKS) {
    out = out.replace(pattern, replace);
  }
  return out;
}
