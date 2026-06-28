import type {
  SearchResponse,
  DownloadStatus,
  HistoryEntry,
  ConfigModel,
  DiagnosticResult,
  UpdateStatus,
  SanCitroApi,
} from "@/types";
import { trackBridgeCall } from "./telemetry";

/** Throws a clear error if the Electron preload script hasn't injected the bridge. */
function ipc(): SanCitroApi {
  if (!window.sanCitro) {
    throw new Error(
      "IPC bridge unavailable — the Electron preload script may not have loaded."
    );
  }
  return window.sanCitro;
}

async function timed<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    trackBridgeCall({ method, durationMs: Math.round(performance.now() - t0), success: true });
    return r;
  } catch (e) {
    trackBridgeCall({ method, durationMs: Math.round(performance.now() - t0), success: false, errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// --------------- Search ---------------

export interface SearchParams {
  query: string;
  page?: number;
  extension?: string;
  language?: string;
}

export async function search(params: SearchParams): Promise<SearchResponse> {
  return timed("search", () => ipc().search({
    query: params.query,
    extension: params.extension,
    language: params.language,
    page: params.page,
  }));
}

// --------------- Downloads ---------------

const MD5_PATTERN = /^[a-fA-F0-9]{32}$/;

function assertValidMd5(md5: string): void {
  if (!MD5_PATTERN.test(md5)) {
    throw new Error("Invalid MD5 hash format.");
  }
}

export interface DownloadMeta {
  author?: string | null;
  year?: number | null;
  extension?: string | null;
  content_type?: string | null;
  language?: string | null;
  publisher?: string | null;
  cover_url?: string | null;
}

export async function startDownload(md5: string, title?: string, meta?: DownloadMeta): Promise<DownloadStatus> {
  assertValidMd5(md5);
  return timed("start_download", () => ipc().startDownload({ md5, title, ...meta }));
}

export async function getActiveDownloads(): Promise<DownloadStatus[]> {
  return timed("get_downloads", () => ipc().getDownloads());
}

export async function cancelDownload(md5: string): Promise<{ status?: string; error?: string }> {
  assertValidMd5(md5);
  return timed("cancel_download", () => ipc().cancelDownload(md5));
}

// --------------- History ---------------

export async function getHistory(): Promise<HistoryEntry[]> {
  return timed("get_history", () => ipc().getHistory());
}

// --------------- Settings ---------------

export async function getSettings(): Promise<ConfigModel> {
  return timed("get_settings", () => ipc().getSettings());
}

export async function updateSettings(
  config: Partial<ConfigModel>
): Promise<ConfigModel> {
  return timed("update_settings", () => ipc().updateSettings(config));
}

export async function reloadConfig(): Promise<ConfigModel> {
  return timed("reload_config", () => ipc().reloadConfig());
}

// --------------- Diagnostics ---------------

export async function getDiagnostics(): Promise<DiagnosticResult[]> {
  return timed("run_diagnostics", () => ipc().runDiagnostics());
}

// --------------- Shell / System ---------------

export async function showOpenDialog(): Promise<string | null> {
  return ipc().showOpenDialog();
}

export async function getAppVersion(): Promise<string> {
  return ipc().getAppVersion();
}

export async function openExternal(url: string): Promise<void> {
  return ipc().openExternal(url);
}

// --------------- Reader ---------------

export async function readBookFile(md5: string): Promise<ArrayBuffer> {
  assertValidMd5(md5);
  return timed("read_book_file", () => ipc().readBookFile(md5));
}

// --------------- Updates ---------------

export async function checkForUpdates(): Promise<UpdateStatus> {
  return timed("check_for_updates", () => ipc().checkForUpdates());
}

export async function quitAndInstall(): Promise<void> {
  return ipc().quitAndInstall();
}

export function onUpdateStatus(cb: (status: UpdateStatus) => void): () => void {
  return ipc().onUpdateStatus(cb);
}
