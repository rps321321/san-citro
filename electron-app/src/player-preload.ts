import { contextBridge, ipcRenderer } from 'electron';

// Preload for the persistent audiobook player view (player.html).
//
// Same sandbox constraint as the main-window preload: a local require('./types')
// throws under sandbox:true, so the channel strings are inlined and MUST stay in
// sync with IPC_CHANNELS in ./types.ts.
const IPC_CHANNELS = {
  PLAYER_LOAD: 'san-citro:player:load',
  PLAYER_SET_MODE: 'san-citro:player:setMode',
  PLAYER_REQUEST_MODE: 'san-citro:player:requestMode',
  GET_AUDIOBOOK_PROGRESS: 'san-citro:getAudiobookProgress',
  SAVE_AUDIOBOOK_PROGRESS: 'san-citro:saveAudiobookProgress',
} as const;

type PlayerMode = 'mini' | 'expanded' | 'hidden';

const api = {
  // main -> view: load an audiobook (md5, detail, progress) into the player.
  onLoad: (callback: (data: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.PLAYER_LOAD, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLAYER_LOAD, listener);
  },

  // main -> view: the host changed our display mode (mini/expanded/hidden).
  onSetMode: (callback: (mode: PlayerMode) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: PlayerMode) => {
      callback(mode);
    };
    ipcRenderer.on(IPC_CHANNELS.PLAYER_SET_MODE, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLAYER_SET_MODE, listener);
  },

  // view -> main: ask the host to switch mode (expand button, collapse, X/close).
  requestMode: (mode: PlayerMode): void => {
    ipcRenderer.send(IPC_CHANNELS.PLAYER_REQUEST_MODE, mode);
  },

  // view -> main: read persisted progress for an md5 (resume position).
  getProgress: (md5: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_AUDIOBOOK_PROGRESS, { md5 }),

  // view -> main: persist progress (called on chapter change / periodic save).
  // Object form — matches PlayerBridge.saveProgress, the web bridge, and the
  // player page's call site, which all pass a single object.
  saveProgress: (p: {
    md5: string;
    chapter_id: number;
    file_position_seconds: number;
  }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_AUDIOBOOK_PROGRESS, p),
};

contextBridge.exposeInMainWorld('player', api);
