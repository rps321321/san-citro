import {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  session,
  shell,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { PythonBridge } from './python-bridge';
import { IPC_CHANNELS } from './types';
import { registerIpcHandlers } from './ipc-handlers';
import { showSplash, closeSplash } from './splash';
import { createTray, destroyTray } from './tray';

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

// Module-level flag — cleaner than monkey-patching app object
let isQuitting = false;

const getMainWindow = (): BrowserWindow | null => mainWindow;

const DOWNLOADS_DIR = path.join(app.getPath('userData'), 'downloads');

// ---------------------------------------------------------------------------
// Custom protocol: san-citro://
// Maps san-citro://app/<file> to the renderer/ directory
// ---------------------------------------------------------------------------
function registerProtocol(): void {
  protocol.registerFileProtocol('san-citro', (request, callback) => {
    // Strip "san-citro://app/" prefix to get the relative file path
    let filePath = request.url.replace(/^san-citro:\/\/app\/?/, '');
    filePath = decodeURIComponent(filePath);

    const rendererDir = path.join(app.getAppPath(), 'renderer');
    let resolvedPath = path.resolve(rendererDir, filePath);

    // Security: prevent directory traversal (case-insensitive on Windows)
    const cmp = process.platform === 'win32'
      ? (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
      : (a: string, b: string) => a.startsWith(b);
    if (!cmp(resolvedPath, rendererDir)) {
      callback({ statusCode: 403 });
      return;
    }

    // #6: SPA-friendly fallback for client-side routing
    if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
      // Try appending .html
      const withHtml = resolvedPath + '.html';
      if (fs.existsSync(withHtml) && fs.statSync(withHtml).isFile()) {
        resolvedPath = withHtml;
      } else {
        // Try appending /index.html
        const withIndex = path.join(resolvedPath, 'index.html');
        if (fs.existsSync(withIndex) && fs.statSync(withIndex).isFile()) {
          resolvedPath = withIndex;
        } else {
          // Fallback: serve the main page (SPA catch-all)
          resolvedPath = path.join(rendererDir, 'search.html');
        }
      }
    }

    callback({ path: resolvedPath });
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
]);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a2e',
      symbolColor: '#e0e0e0',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL('san-citro://app/search.html');

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
    if (!url.startsWith('san-citro://')) {
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

  // 5. Register bridge IPC handlers
  registerIpcHandlers(bridge, getMainWindow);

  // 6. Set up CSP BEFORE creating the window (must be active before loadURL fires)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' san-citro:; " +
          // epub.js and Next.js require unsafe-inline/unsafe-eval for now
          "script-src 'self' san-citro: 'unsafe-inline' 'unsafe-eval'; " +
          "style-src 'self' san-citro: 'unsafe-inline' blob:; " +
          // epub.js renders into a blob: iframe
          "frame-src 'self' san-citro: blob:; " +
          "img-src 'self' san-citro: data: blob: https:; " +
          "connect-src 'self' san-citro: blob:; " +
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

  // 7. Create main window (AFTER CSP is active)
  const win = createMainWindow();

  // 8. When main window is ready, close splash and show it
  win.once('ready-to-show', () => {
    closeSplash();
    win.show();
    win.focus();
  });

  // 9. Fallback: close splash after 10s even if window hasn't loaded
  setTimeout(() => {
    closeSplash();
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
    }
  }, 10_000);

  // 10. Create system tray
  createTray(getMainWindow, DOWNLOADS_DIR);
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
