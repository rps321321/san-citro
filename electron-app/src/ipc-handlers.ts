import { ipcMain, BrowserWindow } from 'electron';
import { PythonBridge } from './python-bridge';
import { IPC_CHANNELS } from './types';

/**
 * Register all IPC handlers that delegate to the Python bridge.
 * Also forward bridge push-events to the renderer process.
 */
export function registerIpcHandlers(
  bridge: PythonBridge,
  getMainWindow: () => BrowserWindow | null
): void {
  // --- Request/response handlers (9 methods) ---

  ipcMain.handle(IPC_CHANNELS.SEARCH, (_event, params) => {
    return bridge.call('search', params);
  });

  ipcMain.handle(IPC_CHANNELS.START_DOWNLOAD, (_event, params) => {
    return bridge.call('start_download', params);
  });

  ipcMain.handle(IPC_CHANNELS.CANCEL_DOWNLOAD, (_event, params) => {
    return bridge.call('cancel_download', params);
  });

  ipcMain.handle(IPC_CHANNELS.GET_DOWNLOADS, () => {
    return bridge.call('get_downloads');
  });

  ipcMain.handle(IPC_CHANNELS.GET_HISTORY, (_event, params) => {
    return bridge.call('get_history', params);
  });

  ipcMain.handle(IPC_CHANNELS.GET_STATS, () => {
    return bridge.call('get_stats');
  });

  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => {
    return bridge.call('get_settings');
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_SETTINGS, (_event, params) => {
    return bridge.call('update_settings', params);
  });

  ipcMain.handle(IPC_CHANNELS.RUN_DIAGNOSTICS, () => {
    return bridge.call('run_diagnostics');
  });

  // --- Forward push-events from bridge to renderer ---

  bridge.on('download_progress', (params) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.DOWNLOAD_PROGRESS, params);
    }
  });

}
