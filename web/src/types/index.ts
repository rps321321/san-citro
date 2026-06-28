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

export interface DownloadStatus {
  md5: string;
  title: string;
  status: "queued" | "started" | "downloading" | "completed" | "failed" | "cancelled";
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
  status: "queued" | "started" | "downloading" | "completed" | "failed" | "cancelled" | (string & {});
  started_at: string | null;
  completed_at: string | null;
  filesize_bytes: number | null;
  error: string | null;
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
  /** Install a downloaded update and restart the app. */
  quitAndInstall(): Promise<void>;
  /** Subscribe to pushed update-status events. Returns an unsubscribe function. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
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
