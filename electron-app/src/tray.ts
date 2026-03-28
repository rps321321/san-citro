import { Tray, Menu, BrowserWindow, app, nativeImage, shell } from 'electron';
import path from 'path';

let tray: Tray | null = null;

/**
 * Create the system tray icon with context menu.
 * Returns the Tray instance for lifecycle management.
 */
export function createTray(
  getMainWindow: () => BrowserWindow | null,
  downloadsDir: string
): Tray {
  const iconPath = path.join(app.getAppPath(), 'resources', 'icon.ico');

  // Fallback: create a simple 16x16 icon if none exists
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = createFallbackIcon();
    }
  } catch {
    icon = createFallbackIcon();
  }

  tray = new Tray(icon);
  tray.setToolTip('San Citro');

  const contextMenu = buildContextMenu(getMainWindow, downloadsDir);
  tray.setContextMenu(contextMenu);

  // Double-click shows the main window
  tray.on('double-click', () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });

  return tray;
}

/** Destroy the tray when the app quits. */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function buildContextMenu(
  getMainWindow: () => BrowserWindow | null,
  downloadsDir: string
): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        const win = getMainWindow();
        if (!win) return;
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
          win.focus();
        }
      },
    },
    {
      label: 'Open Downloads Folder',
      click: () => {
        shell.openPath(downloadsDir);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        (app as Electron.App & { isQuitting?: boolean }).isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/** Generate a minimal tray icon when no icon file is found. */
function createFallbackIcon(): Electron.NativeImage {
  // 16x16 solid dark square as a placeholder
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4] = 0x33;     // R
    buffer[i * 4 + 1] = 0x33; // G
    buffer[i * 4 + 2] = 0x66; // B
    buffer[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}
