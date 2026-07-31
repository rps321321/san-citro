import {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  session,
  shell,
  net,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'node:url';
import log from 'electron-log';
import { PythonBridge } from './python-bridge';
import { IPC_CHANNELS } from './types';
import { registerIpcHandlers } from './ipc-handlers';
import { registerMediaProtocol } from './media-protocol';
import { showSplash, closeSplash } from './splash';
import {
  createTray,
  destroyTray,
  refreshTrayUpdatePresentation,
} from './tray';
import {
  startUpdateStatusOwner,
  checkForUpdates,
  quitAndInstall,
  getUpdateStatus,
  subscribeUpdateStatus,
} from './updater';

// ---------------------------------------------------------------------------
// Never crash on a broken stdout/stderr pipe. When the app is launched from a
// parent that later closes the pipe (a shell, CI, a wrapping process), main-process
// console writes — e.g. the Python-bridge stderr forwarder — throw EPIPE
// *synchronously*, which a stream 'error' listener cannot catch, so it surfaces as
// an unhandled exception that takes down the whole app. Route all console output
// through electron-log's file transport and turn off its console transport, so
// nothing in the main process writes to stdout/stderr. Stream-error no-ops are a
// belt-and-suspenders guard for any remaining direct writes.
// ---------------------------------------------------------------------------
if (log.transports?.console) log.transports.console.level = false;
console.log = (...args: unknown[]) => log.info(...args);
console.info = (...args: unknown[]) => log.info(...args);
console.warn = (...args: unknown[]) => log.warn(...args);
console.error = (...args: unknown[]) => log.error(...args);
console.debug = (...args: unknown[]) => log.debug(...args);
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ---------------------------------------------------------------------------
// Single instance lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
const bridge = new PythonBridge();

// ponytail: dev-only HMR loader. Set SAN_CITRO_DEV_SERVER_URL=http://localhost:3000
// (with `next dev` running there) to load the live Next.js server instead of the
// static san-citro:// build, so renderer edits hot-reload without a rebuild+relaunch.
const DEV_SERVER_URL = !app.isPackaged ? process.env.SAN_CITRO_DEV_SERVER_URL || '' : '';

// Module-level flag — cleaner than monkey-patching app object
let isQuitting = false;

const getMainWindow = (): BrowserWindow | null => mainWindow;

const DOWNLOADS_DIR = app.getPath('downloads');

// ---------------------------------------------------------------------------
// Custom protocol: san-citro://
// Maps san-citro://app/<file> to the renderer/ directory
// ---------------------------------------------------------------------------
function registerProtocol(): void {
  // In a packaged build the renderer ships as an extraResource at
  // <resources>/renderer (a sibling of app.asar). In dev it sits next to the
  // app at app.getAppPath().
  const rendererDir = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer')
    : path.join(app.getAppPath(), 'renderer');

  // protocol.handle (Electron 25+) replaces the deprecated registerFileProtocol.
  // With standard:true (registered as privileged below), san-citro://app/<path>
  // parses as host="app" + a real pathname, so relative _next assets resolve
  // correctly and the renderer is a secure context.
  protocol.handle('san-citro', async (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    let resolvedPath = path.resolve(rendererDir, rel);

    // Security: block path traversal outside the renderer dir.
    const within = path.relative(rendererDir, resolvedPath);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      return new Response('forbidden', { status: 403 });
    }

    // SPA-friendly fallback for client-side routing:
    // file → file.html → dir/index.html → the app shell (search.html).
    if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
      const withHtml = resolvedPath + '.html';
      const withIndex = path.join(resolvedPath, 'index.html');
      if (fs.existsSync(withHtml) && fs.statSync(withHtml).isFile()) {
        resolvedPath = withHtml;
      } else if (fs.existsSync(withIndex) && fs.statSync(withIndex).isFile()) {
        resolvedPath = withIndex;
      } else {
        // SPA shell: every unresolved route falls back to the HashRouter entry.
        resolvedPath = path.join(rendererDir, 'index.html');
      }
    }

    return net.fetch(pathToFileURL(resolvedPath).toString());
  });
}

// Register the scheme as privileged before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'san-citro',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    // Audiobook chapter media. stream:true is REQUIRED so <audio> seeking can
    // issue HTTP Range requests against the protocol handler.
    scheme: 'san-citro-media',
    privileges: {
      standard: false,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    // Sized so standard pages fit without a page-level scrollbar; the min is a
    // firm floor that keeps them scrollbar-free (and stays screen-safe ~840px).
    width: 1360,
    height: 920,
    minWidth: 1120,
    minHeight: 840,
    show: false,
    // Zero-alpha bg + Mica: the Windows 11 DWM paints the translucent material
    // behind the window (Codex-style "semi-transparent sidebar"). Translucent
    // renderer surfaces (the sidebar) show it; opaque panels stay readable.
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a2e',
      symbolColor: '#e0e0e0',
      // Matches the h-9 title-bar band; the renderer re-syncs color per theme.
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(DEV_SERVER_URL || 'san-citro://app/index.html');

  // Open DevTools only during development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Log renderer crashes
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] Renderer crashed:', details.reason, details.exitCode);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[main] Failed to load:', errorCode, errorDescription, validatedURL);
  });

  // Hide to tray on close instead of quitting (unless app is actually quitting)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Prevent the renderer from navigating away from san-citro:// protocol
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('san-citro://') && !(DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL))) {
      event.preventDefault();
      console.warn('[main] Blocked navigation to:', url);
    }
  });

  // Prevent new windows — open external URLs in default browser instead
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // 1. Register custom protocol
  registerProtocol();

  // 2. Show splash screen
  const splash = showSplash();

  // 3. Register utility IPC handlers
  ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, () => app.getVersion());

  // 4. Start the Python bridge
  try {
    await bridge.spawn();
  } catch (err) {
    console.error('[main] Failed to spawn Python bridge:', err);
  }

  // 5. Single Update status owner before any window/IPC client can call it.
  // Owns library wiring, snapshot, check, quit-and-install, renderer push.
  // Main must not call electron-updater on a parallel path (issue #48).
  startUpdateStatusOwner({
    isPackaged: app.isPackaged,
    getMainWindow,
  });

  // 6. Register bridge IPC handlers (update IPC uses the owner above)
  registerIpcHandlers(bridge, getMainWindow);

  // 6b. Register the audiobook media protocol (san-citro-media://).
  registerMediaProtocol(bridge);

  // 7. Set up CSP BEFORE creating the window (must be active before loadURL fires)
  // Dev HMR needs the Next dev server origin + its websocket for fast refresh.
  const devConnect = DEV_SERVER_URL ? `${DEV_SERVER_URL} ${DEV_SERVER_URL.replace('http', 'ws')} ` : '';
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' san-citro: ${devConnect}; ` +
          // epub.js and Next.js require unsafe-inline/unsafe-eval for now
          `script-src 'self' san-citro: ${devConnect}'unsafe-inline' 'unsafe-eval'; ` +
          "style-src 'self' san-citro: 'unsafe-inline' blob:; " +
          // epub.js renders into a blob: iframe
          "frame-src 'self' san-citro: blob:; " +
          "img-src 'self' san-citro: data: blob: https:; " +
          // <audio> in the player view streams chapters over san-citro-media://
          "media-src san-citro-media:; " +
          // Update this domain when NEXT_PUBLIC_SUPABASE_URL changes in web/.env.local
          `connect-src 'self' san-citro: blob: ${devConnect}https://uxykfosgpcjexqqdzhsp.supabase.co; ` +
          "font-src 'self' san-citro: data: blob:; " +
          // Harden: restrict object embeds, base URI, form targets, workers
          "object-src 'none'; " +
          "base-uri 'self'; " +
          "form-action 'self' san-citro:; " +
          "worker-src 'self' san-citro: blob:;",
        ],
      },
    });
  });

  // 8. Create main window (AFTER CSP is active)
  const win = createMainWindow();

  // 9. When main window is ready, close splash and show it
  win.once('ready-to-show', () => {
    closeSplash();
    win.show();
    win.focus();
  });

  // 10. Fallback: close splash after 10s even if window hasn't loaded
  setTimeout(() => {
    closeSplash();
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
    }
  }, 10_000);

  // 11. Create system tray — projection over the owner only (no local store).
  createTray(
    getMainWindow,
    DOWNLOADS_DIR,
    () => {
      void checkForUpdates();
    },
    () => quitAndInstall(),
    () => getUpdateStatus()
  );
  subscribeUpdateStatus(() => {
    refreshTrayUpdatePresentation();
  });

  // 12. Launch-time check (same owner method as manual IPC / tray check).
  // Non-packaged builds dispatch a live not-available snapshot.
  try {
    await checkForUpdates();
  } catch (err) {
    console.error('[main] Auto-update check failed:', err);
  }
});

app.on('window-all-closed', () => {
  // On Windows, don't quit when all windows close (tray keeps running)
  // Only quit on macOS if quitting flag is set
  if (process.platform !== 'win32') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS: re-create window when dock icon is clicked
  if (!mainWindow) {
    createMainWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', async (event) => {
  event.preventDefault();

  destroyTray();

  // Hard timeout to prevent the app from hanging forever if bridge.kill() stalls
  try {
    await Promise.race([
      bridge.kill(),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  } catch (err) {
    console.error('[main] Error killing bridge:', err);
  } finally {
    app.exit(0);
  }
});
