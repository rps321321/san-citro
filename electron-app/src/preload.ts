import { contextBridge, ipcRenderer, shell } from 'electron';
import { IPC_CHANNELS } from './types';

// The preload is a thin pass-through layer. It does NOT own domain types —
// the frontend (web/src/types) is the single source of truth. All return
// types are typed as `Promise<unknown>` here; the renderer casts them.

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

  openExternal: (url: string): Promise<void> => {
    // Only allow HTTPS URLs to prevent abuse (file://, smb://, protocol handlers)
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return Promise.reject(new Error('Only HTTP(S) URLs are allowed'));
      }
    } catch {
      return Promise.reject(new Error('Invalid URL'));
    }
    return shell.openExternal(url);
  },

  showItemInFolder: (filePath: string): void => {
    // Basic validation — reject obviously malicious paths
    if (!filePath || filePath.includes('\0')) return;
    shell.showItemInFolder(filePath);
  },
};

contextBridge.exposeInMainWorld('sanCitro', api);
