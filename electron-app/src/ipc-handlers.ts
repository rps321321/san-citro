import { ipcMain, BrowserWindow, shell, dialog, app, Notification } from 'electron';
import { promises as fsp } from 'fs';
import { PythonBridge } from './python-bridge';
import { IPC_CHANNELS } from './types';
import { checkForUpdates, quitAndInstall } from './updater';

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

  ipcMain.handle(IPC_CHANNELS.LIST_LIBRARY, () => {
    return bridge.call('list_library');
  });

  ipcMain.handle(IPC_CHANNELS.LIST_AUDIOBOOKS, () => {
    return bridge.call('list_audiobooks');
  });

  ipcMain.handle(IPC_CHANNELS.GET_AUDIOBOOK_DETAIL, (_event, { md5 }: { md5: string }) => {
    return bridge.call('get_audiobook_detail', { md5 });
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

  ipcMain.handle(IPC_CHANNELS.RELOAD_CONFIG, () => {
    return bridge.call('reload_config');
  });

  ipcMain.handle(IPC_CHANNELS.RUN_DIAGNOSTICS, () => {
    return bridge.call('run_diagnostics');
  });

  ipcMain.handle(IPC_CHANNELS.SET_TELEMETRY_CONTEXT, (_event, ctx) => {
    return bridge.call('set_telemetry_context', ctx);
  });

  // --- Shell access (owned by main process under sandboxed preload) ---

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    // HTTP(S)-only guard (moved here from preload)
    const protocol = new URL(url).protocol;
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new Error('Only HTTP(S) URLs are allowed');
    }
    return shell.openExternal(url);
  });

  ipcMain.handle(
    IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    async (_event, { md5 }: { md5: string }) => {
      // Resolve to a validated absolute path via the Python bridge, then reveal it.
      const abs = (await bridge.call('resolve_download_path', { md5 })) as
        | string
        | null;
      if (abs) {
        shell.showItemInFolder(abs);
      }
    }
  );

  // Read a downloaded book's bytes (for the in-app epub reader). Resolves the
  // validated absolute path via the bridge, then returns the file as an
  // ArrayBuffer (structured-cloned across IPC).
  ipcMain.handle(
    IPC_CHANNELS.READ_BOOK_FILE,
    async (_event, { md5 }: { md5: string }): Promise<ArrayBuffer> => {
      const abs = (await bridge.call('resolve_download_path', { md5 })) as
        | string
        | null;
      if (!abs) {
        throw new Error('Downloaded file not found for this book.');
      }
      const buf = await fsp.readFile(abs);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  );

  // Native folder picker (sandboxed preload cannot import dialog).
  ipcMain.handle(IPC_CHANNELS.SHOW_OPEN_DIALOG, async () => {
    const win = getMainWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // --- Auto-update ---

  ipcMain.handle(IPC_CHANNELS.CHECK_FOR_UPDATES, () => {
    return checkForUpdates(app.isPackaged);
  });

  ipcMain.handle(IPC_CHANNELS.QUIT_AND_INSTALL, () => {
    quitAndInstall();
  });

  // Synchronous app version — exposed as a preload property so telemetry can read
  // it before any async round-trip (it stamps every row, incl. the startup handshake).
  ipcMain.on(IPC_CHANNELS.GET_APP_VERSION_SYNC, (event) => {
    event.returnValue = app.getVersion();
  });

  // --- Forward push-events from bridge to renderer ---

  bridge.on('download_progress', (params) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.DOWNLOAD_PROGRESS, params);
    }

    // OS notification on completion when the window isn't focused.
    const p = params as { status?: string; title?: string };
    if (
      p.status === 'completed' &&
      (!win || !win.isFocused()) &&
      Notification.isSupported()
    ) {
      new Notification({
        title: 'Download complete',
        body: p.title ?? 'Your download has finished.',
      }).show();
    }
  });

  bridge.on('audiobook_status', (params) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AUDIOBOOK_STATUS, params);
    }
  });

}
