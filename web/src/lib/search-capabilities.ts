/**
 * Bootstrap Search capabilities for cold-start UI (#61).
 *
 * Authoritative values come from the Python Search boundary
 * (`src/search_capabilities.py`) on every search response. This module only
 * seeds the toolbar before the first response so format/language/sort can be
 * chosen pre-search. After a successful search, the hook replaces state with
 * `response.capabilities`.
 *
 * Keep labels/values aligned with the Python module; contract tests cover the
 * bridge payload shape. Do not treat this file as the product source of truth.
 */

import type { SearchCapabilities } from "@/types";

export const BOOTSTRAP_SEARCH_CAPABILITIES: SearchCapabilities = {
  sorts: [
    { value: "", label: "Relevance" },
    { value: "newest", label: "Newest" },
    { value: "oldest", label: "Oldest" },
    { value: "largest", label: "Largest" },
    { value: "smallest", label: "Smallest" },
    { value: "newest_added", label: "Recently added" },
    { value: "oldest_added", label: "Oldest added" },
  ],
  extensions: [
    { value: "pdf", label: "PDF" },
    { value: "epub", label: "EPUB" },
    { value: "djvu", label: "DJVU" },
    { value: "mobi", label: "MOBI" },
    { value: "azw3", label: "AZW3" },
    { value: "fb2", label: "FB2" },
    { value: "txt", label: "TXT" },
    { value: "cbr", label: "CBR" },
    { value: "cbz", label: "CBZ" },
  ],
  languages: [
    { value: "English", label: "English" },
    { value: "Russian", label: "Russian" },
    { value: "German", label: "German" },
    { value: "French", label: "French" },
    { value: "Spanish", label: "Spanish" },
    { value: "Italian", label: "Italian" },
    { value: "Chinese", label: "Chinese" },
    { value: "Japanese", label: "Japanese" },
    { value: "Portuguese", label: "Portuguese" },
  ],
};
