/**
 * Shared window.sanCitro mock for component tests.
 *
 * Install before render; always uninstall in afterEach so tests stay isolated.
 *
 * Usage:
 *   import { installSanCitroMock, uninstallSanCitroMock } from "@/test/mock-san-citro";
 *   beforeEach(() => { installSanCitroMock({ getAppVersion: async () => "9.9.9" }); });
 *   afterEach(() => { uninstallSanCitroMock(); });
 */

import type { SanCitroApi } from "@/types";

/** No-op unsubscribe returned by mock event subscriptions. */
const noopUnsub = () => {};

/**
 * Build a complete SanCitroApi with promise/noop defaults.
 * Pass `overrides` to stub only the methods a test exercises.
 */
export function createSanCitroMock(
  overrides: Partial<SanCitroApi> = {}
): SanCitroApi {
  const base: SanCitroApi = {
    appVersion: "0.0.0-test",
    search: async () => ({
      results: [],
      total_count: 0,
      page: 1,
      has_next: false,
      has_prev: false,
      sort: "",
      capabilities: {
        sorts: [{ value: "", label: "Relevance" }, { value: "newest", label: "Newest" }],
        extensions: [{ value: "epub", label: "EPUB" }, { value: "pdf", label: "PDF" }],
        languages: [{ value: "English", label: "English" }],
      },
    }),
    startDownload: async ({ md5, title }) => ({
      md5,
      title: title ?? "",
      status: "queued",
      progress_percent: 0,
      total_bytes: 0,
      downloaded_bytes: 0,
      error: null,
      filename: null,
      file_path: null,
      started_at: null,
    }),
    cancelDownload: async () => ({ status: "cancelled" }),
    getDownloads: async () => [],
    getHistory: async () => [],
    getStats: async () => ({}),
    getSettings: async () => ({
      out_dir: "",
      concurrency: 1,
      proxies: [],
    }),
    updateSettings: async (params) => ({
      out_dir: params.out_dir ?? "",
      concurrency: params.concurrency ?? 1,
      proxies: params.proxies ?? [],
    }),
    reloadConfig: async () => ({
      out_dir: "",
      concurrency: 1,
      proxies: [],
    }),
    runDiagnostics: async () => [],
    onDownloadProgress: () => noopUnsub,
    showItemInFolder: async () => {},
    readBookFile: async () => new ArrayBuffer(0),
    showOpenDialog: async () => null,
    getAppVersion: async () => "0.0.0-test",
    openExternal: async () => {},
    checkForUpdates: async () => ({ status: "idle" }),
    getUpdateStatus: async () => ({ status: "idle" }),
    quitAndInstall: async () => {},
    onUpdateStatus: () => noopUnsub,
    listLibrary: async () => ({
      items: [],
      facets: { content_types: [], extensions: [], languages: [] },
      total_eligible: 0,
      filtered_count: 0,
    }),
    getAudiobookDetail: async () => ({
      audiobook: null,
      chapters: [],
    }),
    onAudiobookStatus: () => noopUnsub,
    playAudiobook: async (md5) => ({
      md5,
      detail: { audiobook: null, chapters: [] },
      progress: null,
    }),
    saveAudiobookProgress: async () => {},
    setTitlebarOverlay: () => {},
    notifyRendererReady: () => {},
    setTelemetryContext: async () => {},
  };

  return { ...base, ...overrides };
}

/** Assign mock to window.sanCitro. Returns the mock for further stubbing. */
export function installSanCitroMock(
  overrides: Partial<SanCitroApi> = {}
): SanCitroApi {
  const mock = createSanCitroMock(overrides);
  window.sanCitro = mock;
  return mock;
}

/** Remove window.sanCitro (call in afterEach). */
export function uninstallSanCitroMock(): void {
  delete window.sanCitro;
}
