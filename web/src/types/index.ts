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

// --------------- Electron IPC Bridge ---------------

export interface SanCitroApi {
  search(params: {
    query: string;
    page?: number;
    extension?: string;
    language?: string;
  }): Promise<SearchResponse>;
  startDownload(params: { md5: string; title?: string }): Promise<DownloadStatus>;
  cancelDownload(md5: string): Promise<{ status?: string; error?: string }>;
  getDownloads(): Promise<DownloadStatus[]>;
  getHistory(): Promise<HistoryEntry[]>;
  getSettings(): Promise<ConfigModel>;
  updateSettings(params: Partial<ConfigModel>): Promise<ConfigModel>;
  reloadConfig(): Promise<ConfigModel>;
  runDiagnostics(): Promise<DiagnosticResult[]>;
  onDownloadProgress(callback: (data: DownloadStatus | DownloadStatus[]) => void): () => void;
  showItemInFolder(md5: string): Promise<void>;
}

declare global {
  interface Window {
    sanCitro?: SanCitroApi;
  }
}
