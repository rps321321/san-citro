// Types matching Python bridge handler return shapes.
// Field nullability aligned with what Python actually returns (not Pydantic models).

export interface BookRecord {
  title: string;
  author: string;
  year: number | null;
  extension: string;
  md5: string;
  language: string;
  filesize_bytes: number;
  publisher: string;
  isbn13: string;
  /** Cover image URL from Anna's Archive search results */
  cover_url?: string | null;
  /** Content type token parsed from the search result card, e.g. "fiction", "non-fiction", "comic" */
  content_type?: string | null;
  /** May be undefined for scraper-fallback results */
  is_downloaded?: boolean;
}

export interface SearchResponse {
  results: BookRecord[];
  /** Number of results on this page (a live scrape has no grand total). */
  total_count: number;
  page: number;
  has_next: boolean;
  has_prev: boolean;
}

/** Live Download lifecycle statuses (CONTEXT.md). History DB may still store internal rows. */
export type LiveDownloadStatus =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadStatus {
  md5: string;
  title: string;
  status: LiveDownloadStatus;
  progress_percent: number;
  total_bytes: number;
  downloaded_bytes: number;
  error: string | null;
  filename: string | null;
  /** Full path to the downloaded file on disk */
  file_path: string | null;
  /** Unix timestamp (seconds) when the download worker started. */
  started_at: number | null;
}

export interface HistoryEntry {
  md5: string;
  title: string | null;
  filename: string | null;
  /** History may include internal DB values (e.g. started, interrupted) not used on the live UI. */
  status: LiveDownloadStatus | "started" | "interrupted" | (string & {});
  started_at: string | null;
  completed_at: string | null;
  filesize_bytes: number | null;
  error: string | null;
}

/** Shared core + Book/Audiobook variant fields from the DB-driven Library query. */
export interface LibraryItem {
  md5: string;
  title: string | null;
  filename: string | null;
  author: string | null;
  year: number | null;
  extension: string | null;
  content_type: string | null;
  language: string | null;
  publisher: string | null;
  cover_url: string | null;
  filesize_bytes: number | null;
  completed_at: string | null;
  /** Authoritative classification: "book" | "audiobook" (NULL DB rows → book). */
  media_type: "book" | "audiobook";
  /** Same as media_type; explicit variant tag for consumers. */
  variant: "book" | "audiobook";
  // Audiobook variant fields (null for books)
  status: string | null;
  container_type: string | null;
  folder_path: string | null;
  total_duration_seconds: number | null;
  track_count: number | null;
  error_message: string | null;
}

export interface LibraryFacets {
  content_types: string[];
  extensions: string[];
  languages: string[];
}

export interface LibraryQueryParams {
  media_kind?: "books" | "audiobooks" | "all";
  content_type?: string | null;
  extension?: string | null;
  language?: string | null;
  sort?: "author" | "year" | "title" | "recent";
}

export interface LibraryQueryResult {
  items: LibraryItem[];
  facets: LibraryFacets;
  /** Count after media_kind, before facet filters (empty vs no-match). */
  total_eligible: number;
  filtered_count: number;
}

export interface Audiobook {
  md5: string;
  title: string | null;
  cover_url: string | null;
  status: string;
  container_type: string | null;
  track_count: number | null;
  total_duration_seconds: number | null;
  error_message: string | null;
}

export interface Chapter {
  chapter_id: number;
  chapter_index: number;
  title: string | null;
  rel_path: string;
  start_offset_seconds: number;
  duration_seconds: number | null;
}

export interface AudiobookDetail {
  audiobook: Audiobook | null;
  chapters: Chapter[];
}

// --------------- Persistent in-page audiobook player (ADR-0013) ---------------

/** Display mode of the in-page player (PlayerContext / InPagePlayer). */
export type PlayerMode = "mini" | "expanded" | "hidden";

/** Saved playback position for an audiobook (null when never played). */
export interface AudiobookProgress {
  md5: string;
  chapter_id: number;
  file_position_seconds: number;
  updated_at: string;
}

/** Result of playAudiobook — loaded into PlayerContext for the in-page player. */
export interface PlayerLoadPayload {
  md5: string;
  detail: AudiobookDetail;
  progress: AudiobookProgress | null;
}

export interface ConfigModel {
  out_dir: string;
  concurrency: number;
  proxies: string[];
}

export interface DiagnosticResult {
  name: string;
  status: "ok" | "fail" | "warn";
  message: string;
}

export interface UpdateStatus {
  status:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  version?: string;
  percent?: number;
  message?: string;
}

// --------------- Electron IPC Bridge ---------------

export interface SanCitroApi {
  search(params: {
    query: string;
    page?: number;
    extension?: string;
    language?: string;
  }): Promise<SearchResponse>;
  startDownload(params: {
    md5: string;
    title?: string;
    author?: string | null;
    year?: number | null;
    extension?: string | null;
    content_type?: string | null;
    language?: string | null;
    publisher?: string | null;
    cover_url?: string | null;
  }): Promise<DownloadStatus>;
  cancelDownload(md5: string): Promise<{ status?: string; error?: string }>;
  getDownloads(): Promise<DownloadStatus[]>;
  getHistory(): Promise<HistoryEntry[]>;
  /** Download history aggregate stats (Python bridge). */
  getStats(): Promise<Record<string, unknown>>;
  getSettings(): Promise<ConfigModel>;
  updateSettings(params: Partial<ConfigModel>): Promise<ConfigModel>;
  reloadConfig(): Promise<ConfigModel>;
  runDiagnostics(): Promise<DiagnosticResult[]>;
  onDownloadProgress(callback: (data: DownloadStatus | DownloadStatus[]) => void): () => void;
  showItemInFolder(md5: string): Promise<void>;
  /** Read a downloaded book's bytes (for the in-app epub reader). */
  readBookFile(md5: string): Promise<ArrayBuffer>;
  /** Native folder picker (openDirectory). Resolves abs path, or null if cancelled. */
  showOpenDialog(): Promise<string | null>;
  /** Current app version string. */
  getAppVersion(): Promise<string>;
  /** Synchronous app version, exposed as a property for telemetry stamping. */
  appVersion: string;
  /** Open a URL in the user's default browser. */
  openExternal(url: string): Promise<void>;
  /** Trigger an electron-updater check; resolves the current update state. */
  checkForUpdates(): Promise<UpdateStatus>;
  /**
   * Latest known update state without starting a new feed check.
   * Used to hydrate UI after a missed push (e.g. already downloaded).
   */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Install a downloaded update and restart the app. */
  quitAndInstall(): Promise<void>;
  /** Subscribe to pushed update-status events. Returns an unsubscribe function. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  /** DB-driven Library query (filters, sort, facets). */
  listLibrary(params?: LibraryQueryParams): Promise<LibraryQueryResult>;
  /** List all audiobooks tracked in the audiobook DB (detail/player path). */
  listAudiobooks(): Promise<Audiobook[]>;
  /** Get detail (audiobook row + chapters) for a single audiobook. */
  getAudiobookDetail(md5: string): Promise<AudiobookDetail>;
  /** Subscribe to live audiobook status events. Returns an unsubscribe function. */
  onAudiobookStatus(cb: (e: { md5: string; status: string }) => void): () => void;
  /** Start (or switch to) playing an audiobook in-page; resolves the load payload. */
  playAudiobook(md5: string): Promise<PlayerLoadPayload>;
  /** Persist the in-page player's playback position. */
  saveAudiobookProgress(p: {
    md5: string;
    chapter_id: number;
    file_position_seconds: number;
  }): Promise<void>;
  /** Theme-sync the OS window-controls overlay colors to the title bar. */
  setTitlebarOverlay(opts: { color: string; symbolColor: string }): void;
  /** Push telemetry context (identity + Supabase creds) to the Python bridge. */
  setTelemetryContext(ctx: {
    device_id: string;
    session_id: string;
    app_version: string;
    supabase_url: string;
    anon_key: string;
  }): Promise<void>;
}

declare global {
  interface Window {
    sanCitro?: SanCitroApi;
  }
}
