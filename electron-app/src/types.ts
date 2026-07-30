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

// IPC channel constants.
// Python-backed relays/composites are also listed in python-commands.ts;
// OS-only and push channels live here only.
// Retired WebContentsView player IPC (ADR-0013) intentionally absent:
// PLAYER_LOAD / PLAYER_SET_MODE / PLAYER_REQUEST_MODE / PLAYER_ACTIVE /
// PLAYER_CONTENT_RECT (bounds chrome for the deleted overlay).

export const IPC_CHANNELS = {
  SEARCH: 'san-citro:search',
  START_DOWNLOAD: 'san-citro:startDownload',
  CANCEL_DOWNLOAD: 'san-citro:cancelDownload',
  GET_DOWNLOADS: 'san-citro:getDownloads',
  GET_HISTORY: 'san-citro:getHistory',
  GET_STATS: 'san-citro:getStats',
  GET_SETTINGS: 'san-citro:getSettings',
  UPDATE_SETTINGS: 'san-citro:updateSettings',
  RELOAD_CONFIG: 'san-citro:reloadConfig',
  RUN_DIAGNOSTICS: 'san-citro:runDiagnostics',
  DOWNLOAD_PROGRESS: 'san-citro:downloadProgress',
  GET_APP_VERSION: 'san-citro:getAppVersion',
  GET_APP_VERSION_SYNC: 'san-citro:getAppVersionSync',
  OPEN_EXTERNAL: 'san-citro:openExternal',
  SHOW_ITEM_IN_FOLDER: 'san-citro:showItemInFolder',
  READ_BOOK_FILE: 'san-citro:readBookFile',
  SHOW_OPEN_DIALOG: 'san-citro:showOpenDialog',
  CHECK_FOR_UPDATES: 'san-citro:checkForUpdates',
  QUIT_AND_INSTALL: 'san-citro:quitAndInstall',
  UPDATE_STATUS: 'san-citro:updateStatus',
  SET_TELEMETRY_CONTEXT: 'san-citro:setTelemetryContext',
  LIST_LIBRARY: 'san-citro:listLibrary',
  LIST_AUDIOBOOKS: 'san-citro:listAudiobooks',
  GET_AUDIOBOOK_DETAIL: 'san-citro:getAudiobookDetail',
  AUDIOBOOK_STATUS: 'san-citro:audiobookStatus',
  // In-page audiobook player (ADR-0013)
  PLAY_AUDIOBOOK: 'san-citro:playAudiobook',
  SAVE_AUDIOBOOK_PROGRESS: 'san-citro:saveAudiobookProgress',
  // renderer -> main: theme-synced colors for the OS window-controls overlay so
  // the control area matches the title-bar background.
  SET_TITLEBAR_OVERLAY: 'san-citro:setTitlebarOverlay',
} as const;

export interface UpdateStatus {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  version?: string;
  percent?: number;
  message?: string;
}
