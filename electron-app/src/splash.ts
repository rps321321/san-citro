import { BrowserWindow } from 'electron';
import path from 'path';
import { app } from 'electron';

let splashWindow: BrowserWindow | null = null;

/** Show the splash screen. Returns the window so the caller can close it later. */
export function showSplash(): BrowserWindow {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    alwaysOnTop: true,
    transparent: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#1a1a2e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const splashPath = path.join(app.getAppPath(), 'resources', 'splash.html');
  splashWindow.loadFile(splashPath);

  splashWindow.once('ready-to-show', () => {
    splashWindow?.show();
  });

  return splashWindow;
}

/** Close the splash screen if it is still open. */
export function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}
