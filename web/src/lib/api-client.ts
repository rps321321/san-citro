import type {
  SearchResponse,
  DownloadStatus,
  HistoryEntry,
  ConfigModel,
  DiagnosticResult,
  SanCitroApi,
} from "@/types";

/** Throws a clear error if the Electron preload script hasn't injected the bridge. */
function ipc(): SanCitroApi {
  if (!window.sanCitro) {
    throw new Error(
      "IPC bridge unavailable — the Electron preload script may not have loaded."
    );
  }
  return window.sanCitro;
}

// --------------- Search ---------------

export interface SearchParams {
  query: string;
  page?: number;
  per_page?: number;
  extension?: string;
  language?: string;
  year_min?: number;
  year_max?: number;
}

export async function search(params: SearchParams): Promise<SearchResponse> {
  return ipc().search({
    query: params.query,
    extension: params.extension,
    language: params.language,
    year_min: params.year_min,
    year_max: params.year_max,
    page: params.page,
    per_page: params.per_page,
  });
}

// --------------- Downloads ---------------

const MD5_PATTERN = /^[a-fA-F0-9]{32}$/;

function assertValidMd5(md5: string): void {
  if (!MD5_PATTERN.test(md5)) {
    throw new Error("Invalid MD5 hash format.");
  }
}

export async function startDownload(md5: string, title?: string): Promise<DownloadStatus> {
  assertValidMd5(md5);
  return ipc().startDownload({ md5, title });
}

export async function getActiveDownloads(): Promise<DownloadStatus[]> {
  return ipc().getDownloads();
}

export async function cancelDownload(md5: string): Promise<{ status?: string; error?: string }> {
  assertValidMd5(md5);
  return ipc().cancelDownload(md5);
}

// --------------- History ---------------

export async function getHistory(): Promise<HistoryEntry[]> {
  return ipc().getHistory();
}

// --------------- Settings ---------------

export async function getSettings(): Promise<ConfigModel> {
  return ipc().getSettings();
}

export async function updateSettings(
  config: Partial<ConfigModel>
): Promise<ConfigModel> {
  return ipc().updateSettings(config);
}

export async function reloadConfig(): Promise<ConfigModel> {
  return ipc().reloadConfig();
}

// --------------- Diagnostics ---------------

export async function getDiagnostics(): Promise<DiagnosticResult[]> {
  return ipc().runDiagnostics();
}
