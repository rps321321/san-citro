import { ipcMain, BrowserWindow, shell, dialog, app, Notification } from 'electron';
import { promises as fsp } from 'fs';
import { PythonBridge } from './python-bridge';
import { IPC_CHANNELS } from './types';
import { registerSimpleRelays, requireMd5 } from './python-commands';
import { checkForUpdates, getUpdateStatus, quitAndInstall } from './updater';

/**
 * Register all IPC handlers.
 * Simple Python relays come from the central descriptor (python-commands.ts);
 * composites and OS-affecting commands stay explicit here.
 */
export function registerIpcHandlers(
  bridge: PythonBridge,
  getMainWindow: () => BrowserWindow | null
): void {
  // --- Simple Python relays (descriptor-driven) ---
  registerSimpleRelays(bridge, (channel, listener) => {
    ipcMain.handle(channel, listener as Parameters<typeof ipcMain.handle>[1]);
  });

  // --- Composite: in-page audiobook player (ADR-0013) ---

  // renderer -> main: start playing an audiobook. Fetch detail + saved progress
  // and return them so the renderer hydrates its PlayerContext directly (no
  // WebContentsView, no PLAYER_LOAD push).
  ipcMain.handle(
    IPC_CHANNELS.PLAY_AUDIOBOOK,
    async (_event, params: { md5?: string }) => {
      const md5 = requireMd5(params);
      const detail = await bridge.call('get_audiobook_detail', { md5 });
      let progress: unknown = null;
      try {
        progress = await bridge.call('get_audiobook_progress', { md5 });
      } catch (err) {
        console.error('[player] get_audiobook_progress failed:', err);
      }
      return { md5, detail, progress };
    }
  );

  // --- Composite / OS-affecting: shell + filesystem ---

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
    async (_event, params: { md5?: string }) => {
      const md5 = requireMd5(params);
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
    async (_event, params: { md5?: string }): Promise<ArrayBuffer> => {
      const md5 = requireMd5(params);
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

  // renderer -> main: recolor the OS window-controls overlay to match the title
  // bar (theme-aware), keeping the 36px height so the buttons fill the band.
  let lastOverlay: { color: string; symbolColor: string } | null = null;
  ipcMain.on(
    IPC_CHANNELS.SET_TITLEBAR_OVERLAY,
    (_event, opts: { color: string; symbolColor: string }) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      // Skip no-op repaints — Windows/Chromium can leave the caption buttons
      // stuck showing their last hover highlight after a programmatic overlay
      // repaint, so we only touch the native overlay when the color actually
      // changes, and nudge the window afterward to force the DWM to repaint
      // the caption-button region cleanly.
      if (lastOverlay && lastOverlay.color === opts.color && lastOverlay.symbolColor === opts.symbolColor) {
        return;
      }
      lastOverlay = opts;
      try {
        win.setTitleBarOverlay({ ...opts, height: 36 });
        const [w, h] = win.getSize();
        win.setSize(w, h + 1);
        win.setSize(w, h);
      } catch {
        /* overlay not enabled on this platform */
      }
    }
  );

  // --- Auto-update ---

  ipcMain.handle(IPC_CHANNELS.CHECK_FOR_UPDATES, () => {
    return checkForUpdates(app.isPackaged);
  });

  // Latest known status without re-checking the feed (hydrate banner/settings
  // after a missed push, or when download finished while UI only saw "available").
  ipcMain.handle(IPC_CHANNELS.GET_UPDATE_STATUS, () => {
    return getUpdateStatus();
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
