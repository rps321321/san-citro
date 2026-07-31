import { Tray, Menu, BrowserWindow, app, nativeImage, shell } from 'electron';
import path from 'path';
import { UpdateStatus } from './types';

let tray: Tray | null = null;

// Captured so we can rebuild the menu when an update becomes available.
// Update status is NOT stored here — the main-side owner is authoritative;
// we always read via getUpdateStatusRef (issue #48).
let getMainWindowRef: (() => BrowserWindow | null) | null = null;
let downloadsDirRef = '';
let onCheckForUpdatesRef: (() => void) | null = null;
let onQuitAndInstallRef: (() => void) | null = null;
let getUpdateStatusRef: (() => UpdateStatus) | null = null;

/**
 * Create the system tray icon with context menu.
 * Returns the Tray instance for lifecycle management.
 *
 * `getUpdateStatus` must read from the single Update status owner — tray is a
 * projection only and must not keep an independent status store.
 */
export function createTray(
  getMainWindow: () => BrowserWindow | null,
  downloadsDir: string,
  onCheckForUpdates: () => void,
  onQuitAndInstall: () => void,
  getUpdateStatus: () => UpdateStatus = () => ({ status: 'idle' })
): Tray {
  getMainWindowRef = getMainWindow;
  downloadsDirRef = downloadsDir;
  onCheckForUpdatesRef = onCheckForUpdates;
  onQuitAndInstallRef = onQuitAndInstall;
  getUpdateStatusRef = getUpdateStatus;

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

  rebuildMenu();

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

/**
 * Project the owner's current Update status into tray tooltip + menu.
 * Does not store status — always re-reads via the injected getter on rebuild.
 * Safe to call on every owner transition (subscriber).
 */
export function refreshTrayUpdatePresentation(): void {
  if (!tray || !getUpdateStatusRef) return;

  const status = getUpdateStatusRef();

  if (status.status === 'downloaded') {
    tray.setToolTip(
      `San Citro — update ${status.version ?? ''} ready to install`.trim()
    );
  } else if (status.status === 'available') {
    tray.setToolTip(
      `San Citro — update ${status.version ?? ''} available`.trim()
    );
  } else {
    tray.setToolTip('San Citro');
  }

  rebuildMenu();
}

function rebuildMenu(): void {
  if (!tray || !getMainWindowRef) return;
  tray.setContextMenu(buildContextMenu(getMainWindowRef, downloadsDirRef));
}

function buildContextMenu(
  getMainWindow: () => BrowserWindow | null,
  downloadsDir: string
): Menu {
  // Read-through only — never cached as tray-owned state (issue #48).
  const status: UpdateStatus = getUpdateStatusRef
    ? getUpdateStatusRef()
    : { status: 'idle' };

  const template: Electron.MenuItemConstructorOptions[] = [
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
  ];

  if (status.status === 'downloaded') {
    template.push({
      label: `Restart to install update ${status.version ?? ''}`.trim(),
      click: () => onQuitAndInstallRef?.(),
    });
  } else if (
    status.status === 'available' ||
    status.status === 'downloading' ||
    status.status === 'checking'
  ) {
    const pct =
      status.status === 'downloading' && status.percent != null
        ? ` ${Math.round(status.percent)}%`
        : '';
    template.push({
      label: `Downloading update ${status.version ?? ''}${pct}…`.trim(),
      enabled: false,
    });
  } else {
    template.push({
      label: 'Check for updates',
      click: () => onCheckForUpdatesRef?.(),
    });
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        (app as Electron.App & { isQuitting?: boolean }).isQuitting = true;
        app.quit();
      },
    }
  );

  return Menu.buildFromTemplate(template);
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
