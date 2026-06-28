// Persistent audiobook player view (ADR-0010).
//
// ONE lazy-built WebContentsView, attached as a SIBLING of the main window's
// page contents via mainWindow.contentView.addChildView. Because it is a sibling
// (not inside the page), full-page reloads of the renderer never destroy it, so
// audio keeps playing across navigation. The view renders player.html over the
// san-citro:// protocol.
//
// Three modes back the settled UX:
//   - mini      : a 72px bottom bar across the window.
//   - expanded  : a near-full-window centered card (two-column player).
//   - hidden    : view kept but invisible (used transiently); destroy frees it.

import path from 'path';
import { BrowserWindow, WebContentsView } from 'electron';
import { app } from 'electron';
import { IPC_CHANNELS, type PlayerMode } from './types';

const MINI_HEIGHT = 72;
const EXPANDED_MARGIN = 24;
const EXPANDED_MAX_WIDTH = 1100;
// Minimum top offset so the expanded card clears the 36px titleBarOverlay.
const EXPANDED_MIN_Y = 36;

type Rect = { x: number; y: number; width: number; height: number };

let playerView: WebContentsView | null = null;
let ownerWindow: BrowserWindow | null = null;
let currentMode: PlayerMode = 'hidden';
// Bound so we can detach window listeners on destroy.
let resyncBounds: (() => void) | null = null;
// The body region (right of the sidebar) the renderer asks us to occupy, so the
// player never covers the sidebar. Null until the first report (full-window fallback).
let contentRect: Rect | null = null;

export function getMode(): PlayerMode {
  return currentMode;
}

function computeBounds(win: BrowserWindow, mode: PlayerMode): Rect {
  const full = win.getContentBounds();

  if (mode === 'expanded') {
    // Fill the body region so the player covers only the content, not the sidebar.
    if (contentRect) {
      return { ...contentRect };
    }
    // Fallback before the renderer reports: a centered card clearing the titlebar.
    const w = Math.min(EXPANDED_MAX_WIDTH, full.width - EXPANDED_MARGIN * 2);
    const x = Math.round((full.width - w) / 2);
    const y = EXPANDED_MIN_Y;
    return { x, y, width: w, height: full.height - y - EXPANDED_MARGIN };
  }

  // mini: a bottom strip across the body region (full width as fallback).
  if (contentRect) {
    return {
      x: contentRect.x,
      y: contentRect.y + contentRect.height - MINI_HEIGHT,
      width: contentRect.width,
      height: MINI_HEIGHT,
    };
  }
  return { x: 0, y: full.height - MINI_HEIGHT, width: full.width, height: MINI_HEIGHT };
}

/** Update the body region the player should occupy, then re-layout. */
export function setContentRect(rect: Rect): void {
  contentRect = rect;
  layout();
}

/** Re-apply bounds for the current mode. Never caches window size. */
function layout(): void {
  if (!playerView || !ownerWindow || ownerWindow.isDestroyed()) return;
  const mode = currentMode === 'hidden' ? 'mini' : currentMode;
  playerView.setBounds(computeBounds(ownerWindow, mode));
}

/**
 * Build the player view on first PLAY (idempotent). Attaches it as a sibling
 * child of the window's contentView and wires resize/full-screen resync.
 */
export function ensurePlayerView(win: BrowserWindow): WebContentsView {
  if (playerView && ownerWindow === win && !win.isDestroyed()) {
    return playerView;
  }

  ownerWindow = win;
  playerView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'player-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Transparent so the player UI's frosted/translucent surfaces show the body
  // softly behind them (glassmorphic look). The page paints its own backdrop.
  playerView.setBackgroundColor('#00000000');
  playerView.setBorderRadius(12);
  win.contentView.addChildView(playerView);
  void playerView.webContents.loadURL('san-citro://app/player.html');

  if (!app.isPackaged) {
    playerView.webContents.openDevTools({ mode: 'detach' });
  }

  // Keep bounds in sync with the window without caching its size.
  resyncBounds = () => layout();
  win.on('resize', resyncBounds);
  win.on('enter-full-screen', resyncBounds);
  win.on('leave-full-screen', resyncBounds);

  // Start hidden until the host calls setMode.
  currentMode = 'hidden';
  playerView.setVisible(false);

  return playerView;
}

/**
 * Switch the player display mode. Re-asserts the view as topmost on every show
 * by re-adding it (a main-window reload re-creates the page contents beneath us;
 * re-adding keeps the player on top). Sends PLAYER_SET_MODE to the view.
 */
export function setMode(mode: PlayerMode): void {
  if (!playerView || !ownerWindow || ownerWindow.isDestroyed()) return;

  if (mode === 'hidden') {
    currentMode = 'hidden';
    playerView.setVisible(false);
    playerView.webContents.send(IPC_CHANNELS.PLAYER_SET_MODE, mode);
    return;
  }

  currentMode = mode;
  playerView.setVisible(true);
  // Re-assert topmost: re-adding an existing child moves it to the front.
  ownerWindow.contentView.addChildView(playerView);
  layout();
  playerView.webContents.send(IPC_CHANNELS.PLAYER_SET_MODE, mode);
}

/** Fully stop, detach and destroy the view to free memory. */
export function destroyPlayerView(): void {
  if (!playerView) {
    currentMode = 'hidden';
    return;
  }

  if (ownerWindow && !ownerWindow.isDestroyed()) {
    if (resyncBounds) {
      ownerWindow.off('resize', resyncBounds);
      ownerWindow.off('enter-full-screen', resyncBounds);
      ownerWindow.off('leave-full-screen', resyncBounds);
    }
    try {
      ownerWindow.contentView.removeChildView(playerView);
    } catch {
      /* already detached */
    }
  }

  try {
    playerView.webContents.close();
  } catch {
    /* already closed */
  }

  playerView = null;
  ownerWindow = null;
  resyncBounds = null;
  currentMode = 'hidden';
}

/** True if the view currently exists (built and not destroyed). */
export function hasPlayerView(): boolean {
  return playerView !== null;
}

/** Send a message to the player view's webContents, if it exists. */
export function sendToPlayer(channel: string, payload: unknown): void {
  if (!playerView || playerView.webContents.isDestroyed()) return;
  playerView.webContents.send(channel, payload);
}
