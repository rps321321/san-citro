import { contextBridge, ipcRenderer } from 'electron';

// The preload is a thin pass-through layer. It does NOT own domain types —
// the frontend (web/src/types) is the single source of truth. All return
// types are typed as `Promise<unknown>` here; the renderer casts them.
//
// NOTE: with sandbox:true a preload may only require `electron` + a tiny
// allowlist (events/timers/url) — a local `require('./types')` throws and
// silently breaks contextBridge. So the channel strings are inlined here;
// they MUST stay in sync with IPC_CHANNELS in ./types.ts.
const IPC_CHANNELS = {
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
  OPEN_EXTERNAL: 'san-citro:openExternal',
  SHOW_ITEM_IN_FOLDER: 'san-citro:showItemInFolder',
} as const;

const api = {
  // --- Request/response methods ---

  search: (params: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH, params),

  startDownload: (params: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.START_DOWNLOAD, params),

  // #2: Accept md5 string, wrap it as { md5 } object for the bridge
  cancelDownload: (md5: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_DOWNLOAD, { md5 }),

  getDownloads: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_DOWNLOADS),

  getHistory: (params?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_HISTORY, params),

  getStats: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_STATS),

  getSettings: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),

  updateSettings: (params: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTINGS, params),

  reloadConfig: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.RELOAD_CONFIG),

  runDiagnostics: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_DIAGNOSTICS),

  // --- Event subscriptions (return unsubscribe function) ---

  onDownloadProgress: (callback: (data: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.DOWNLOAD_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DOWNLOAD_PROGRESS, listener);
    };
  },

  // --- Utilities ---

  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION),

  // Shell access lives in the main process (sandboxed preload cannot import shell).
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),

  showItemInFolder: (md5: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, { md5 }),
};

contextBridge.exposeInMainWorld('sanCitro', api);
