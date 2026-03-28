// JSON-RPC protocol types — the ONLY types owned by the Electron layer.
// Domain/model types live in web/src/types and are the single source of truth.

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcEvent {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// IPC channel constants

export const IPC_CHANNELS = {
  SEARCH: 'san-citro:search',
  START_DOWNLOAD: 'san-citro:startDownload',
  CANCEL_DOWNLOAD: 'san-citro:cancelDownload',
  GET_DOWNLOADS: 'san-citro:getDownloads',
  GET_HISTORY: 'san-citro:getHistory',
  GET_STATS: 'san-citro:getStats',
  GET_SETTINGS: 'san-citro:getSettings',
  UPDATE_SETTINGS: 'san-citro:updateSettings',
  RUN_DIAGNOSTICS: 'san-citro:runDiagnostics',
  DOWNLOAD_PROGRESS: 'san-citro:downloadProgress',
  GET_APP_VERSION: 'san-citro:getAppVersion',
} as const;
