/**
 * Central descriptors for Python-backed desktop commands.
 *
 * - `relay`: 1:1 Electron IPC → Python JSON-RPC; registered by one helper.
 * - `composite`: multi-step / adapter; explicit handler in ipc-handlers.
 * - `internal`: Python method used only by main (media protocol, composites);
 *   not a renderer-facing IPC channel of its own.
 *
 * Preload keep a self-contained allowlist (sandbox cannot require this file).
 * Contract tests keep descriptor, preload, renderer types, Electron registration,
 * and the Python registry in agreement.
 */

import { IPC_CHANNELS } from './types';

/** How main invokes a Python-backed command. */
export type PythonCommandMode = 'relay' | 'composite' | 'internal';

export interface PythonCommandDescriptor {
  /**
   * JSON-RPC method name on the Python bridge.
   * For composites that orchestrate several methods this is the *primary*
   * identity used in contract listings; see `usesMethods` for the full set.
   */
  method: string;
  /**
   * IPC channel when renderer-facing (relay or composite entry point).
   * `null` for internal-only methods with no dedicated channel.
   */
  channel: string | null;
  mode: PythonCommandMode;
  /**
   * Preload / `window.sanCitro` method name when renderer-facing.
   * Required for relay and composite; omitted for internal.
   */
  apiName?: string;
  /**
   * For composites: every Python JSON-RPC method this handler may call.
   * For relays: equals `[method]`. For internal: equals `[method]`.
   */
  usesMethods: readonly string[];
}

/**
 * Authoritative list of Python-backed commands.
 * Simple relays are auto-registered; composites stay explicit in ipc-handlers.
 */
export const PYTHON_COMMANDS: readonly PythonCommandDescriptor[] = [
  // --- Simple relays (auto-registered) ---
  {
    method: 'search',
    channel: IPC_CHANNELS.SEARCH,
    mode: 'relay',
    apiName: 'search',
    usesMethods: ['search'],
  },
  {
    method: 'start_download',
    channel: IPC_CHANNELS.START_DOWNLOAD,
    mode: 'relay',
    apiName: 'startDownload',
    usesMethods: ['start_download'],
  },
  {
    method: 'cancel_download',
    channel: IPC_CHANNELS.CANCEL_DOWNLOAD,
    mode: 'relay',
    apiName: 'cancelDownload',
    usesMethods: ['cancel_download'],
  },
  {
    method: 'get_downloads',
    channel: IPC_CHANNELS.GET_DOWNLOADS,
    mode: 'relay',
    apiName: 'getDownloads',
    usesMethods: ['get_downloads'],
  },
  {
    method: 'get_history',
    channel: IPC_CHANNELS.GET_HISTORY,
    mode: 'relay',
    apiName: 'getHistory',
    usesMethods: ['get_history'],
  },
  {
    method: 'get_stats',
    channel: IPC_CHANNELS.GET_STATS,
    mode: 'relay',
    apiName: 'getStats',
    usesMethods: ['get_stats'],
  },
  {
    method: 'get_settings',
    channel: IPC_CHANNELS.GET_SETTINGS,
    mode: 'relay',
    apiName: 'getSettings',
    usesMethods: ['get_settings'],
  },
  {
    method: 'update_settings',
    channel: IPC_CHANNELS.UPDATE_SETTINGS,
    mode: 'relay',
    apiName: 'updateSettings',
    usesMethods: ['update_settings'],
  },
  {
    method: 'reload_config',
    channel: IPC_CHANNELS.RELOAD_CONFIG,
    mode: 'relay',
    apiName: 'reloadConfig',
    usesMethods: ['reload_config'],
  },
  {
    method: 'run_diagnostics',
    channel: IPC_CHANNELS.RUN_DIAGNOSTICS,
    mode: 'relay',
    apiName: 'runDiagnostics',
    usesMethods: ['run_diagnostics'],
  },
  {
    method: 'set_telemetry_context',
    channel: IPC_CHANNELS.SET_TELEMETRY_CONTEXT,
    mode: 'relay',
    apiName: 'setTelemetryContext',
    usesMethods: ['set_telemetry_context'],
  },
  {
    method: 'list_library',
    channel: IPC_CHANNELS.LIST_LIBRARY,
    mode: 'relay',
    apiName: 'listLibrary',
    usesMethods: ['list_library'],
  },
  // list_audiobooks product IPC retired (#47). Library is the sole collection
  // query; internal DB list_audiobooks remains for queue resweep only.
  {
    method: 'get_audiobook_detail',
    channel: IPC_CHANNELS.GET_AUDIOBOOK_DETAIL,
    mode: 'relay',
    apiName: 'getAudiobookDetail',
    usesMethods: ['get_audiobook_detail'],
  },
  {
    method: 'save_audiobook_progress',
    channel: IPC_CHANNELS.SAVE_AUDIOBOOK_PROGRESS,
    mode: 'relay',
    apiName: 'saveAudiobookProgress',
    usesMethods: ['save_audiobook_progress'],
  },

  // --- Composites (explicit handlers; Python-backed) ---
  {
    // Multi-step: detail + progress; no single play_audiobook RPC.
    method: 'play_audiobook',
    channel: IPC_CHANNELS.PLAY_AUDIOBOOK,
    mode: 'composite',
    apiName: 'playAudiobook',
    usesMethods: ['get_audiobook_detail', 'get_audiobook_progress'],
  },
  {
    method: 'show_item_in_folder',
    channel: IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    mode: 'composite',
    apiName: 'showItemInFolder',
    usesMethods: ['resolve_download_path'],
  },
  {
    method: 'read_book_file',
    channel: IPC_CHANNELS.READ_BOOK_FILE,
    mode: 'composite',
    apiName: 'readBookFile',
    usesMethods: ['resolve_download_path'],
  },

  // --- Internal Python methods (main/media protocol; no dedicated renderer IPC) ---
  {
    method: 'resolve_download_path',
    channel: null,
    mode: 'internal',
    usesMethods: ['resolve_download_path'],
  },
  {
    method: 'get_chapter_path',
    channel: null,
    mode: 'internal',
    usesMethods: ['get_chapter_path'],
  },
  {
    method: 'get_audiobook_progress',
    channel: null,
    mode: 'internal',
    usesMethods: ['get_audiobook_progress'],
  },
] as const;

/** Simple relays only — used by the registration helper. */
export function listSimpleRelays(): readonly PythonCommandDescriptor[] {
  return PYTHON_COMMANDS.filter((c) => c.mode === 'relay');
}

/** Renderer-facing Python-backed commands (relay + composite). */
export function listRendererFacingCommands(): readonly PythonCommandDescriptor[] {
  return PYTHON_COMMANDS.filter((c) => c.mode === 'relay' || c.mode === 'composite');
}

/** Union of every JSON-RPC method name the Python registry must expose. */
export function listAllPythonMethods(): string[] {
  const methods = new Set<string>();
  for (const cmd of PYTHON_COMMANDS) {
    for (const m of cmd.usesMethods) {
      methods.add(m);
    }
  }
  // Internal entries also contribute their method identity when not already listed
  // via usesMethods of a composite (get_chapter_path is internal-only).
  for (const cmd of PYTHON_COMMANDS) {
    if (cmd.mode === 'internal') {
      methods.add(cmd.method);
    }
  }
  return [...methods].sort();
}

/**
 * Retired WebContentsView player channels (ADR-0013) — must stay absent from
 * all live command representations (types, preload, IPC handlers, renderer).
 * Includes load/mode and the bounds/active/content-rect chrome used by ADR-0010.
 */
export const RETIRED_PLAYER_CHANNELS: readonly string[] = [
  'san-citro:player:load',
  'san-citro:player:setMode',
  'san-citro:player:requestMode',
  'san-citro:player:active',
  'san-citro:player:content-rect',
];

/** IPC_CHANNELS object keys that must never reappear (ADR-0013). */
export const RETIRED_PLAYER_CHANNEL_KEYS: readonly string[] = [
  'PLAYER_LOAD',
  'PLAYER_SET_MODE',
  'PLAYER_REQUEST_MODE',
  'PLAYER_ACTIVE',
  'PLAYER_CONTENT_RECT',
];

/**
 * Trusted-seam param check for md5-keyed composites (playAudiobook, showItemInFolder, readBookFile).
 * Pure so contract tests can exercise it without Electron.
 */
export function requireMd5(params: unknown): string {
  const md5 =
    params && typeof params === 'object' && 'md5' in params
      ? (params as { md5?: unknown }).md5
      : undefined;
  if (typeof md5 !== 'string' || !md5) {
    throw new Error('md5 is required');
  }
  return md5;
}

/**
 * Register every simple relay: IPC channel → bridge.call(method, params).
 * Injectable for unit tests (fake ipcMain.handle + fake bridge).
 */
export function registerSimpleRelays(
  bridge: { call: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  handle: (channel: string, listener: (...args: unknown[]) => unknown) => void
): void {
  for (const cmd of listSimpleRelays()) {
    if (!cmd.channel) continue;
    const method = cmd.method;
    handle(cmd.channel, (_event: unknown, params?: unknown) => {
      const p =
        params !== undefined && params !== null && typeof params === 'object'
          ? (params as Record<string, unknown>)
          : {};
      return bridge.call(method, p);
    });
  }
}
