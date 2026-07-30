/**
 * Ticket #28 — In-page player keeps one <audio> across mini/expanded.
 *
 * Mini and expanded chrome must share a single media element so mode toggles
 * do not remount audio and interrupt playback.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InPagePlayer } from "@/components/in-page-player";
import { PlayerProvider, usePlayer } from "@/contexts/player-context";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";
import type { PlayerLoadPayload } from "@/types";

const SAMPLE_MD5 = "26ef9f66be1268c180004715e19b1b30";

const SAMPLE_PAYLOAD: PlayerLoadPayload = {
  md5: SAMPLE_MD5,
  detail: {
    audiobook: {
      md5: SAMPLE_MD5,
      title: "Test Audiobook",
      cover_url: null,
      status: "ready",
      container_type: "m4b",
      track_count: 2,
      total_duration_seconds: 120,
      error_message: null,
    },
    chapters: [
      {
        chapter_id: 1,
        chapter_index: 0,
        title: "Chapter One",
        rel_path: "01.m4a",
        start_offset_seconds: 0,
        duration_seconds: 60,
      },
      {
        chapter_id: 2,
        chapter_index: 1,
        title: "Chapter Two",
        rel_path: "02.m4a",
        start_offset_seconds: 0,
        duration_seconds: 60,
      },
    ],
  },
  progress: null,
};

/** Harness: load a session via PlayerProvider.play, then render chrome. */
function PlayerHarness() {
  const { play, payload } = usePlayer();
  return (
    <div>
      <button type="button" onClick={() => void play(SAMPLE_MD5)}>
        Load session
      </button>
      <span data-testid="has-payload">{payload ? "yes" : "no"}</span>
      <InPagePlayer />
    </div>
  );
}

beforeEach(() => {
  // jsdom's HTMLMediaElement is incomplete; stub methods the player calls.
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  uninstallSanCitroMock();
  vi.restoreAllMocks();
});

describe("InPagePlayer audio identity across modes (#28)", () => {
  it("keeps a single audio DOM node when toggling mini → expanded → mini", async () => {
    const user = userEvent.setup();
    installSanCitroMock({
      playAudiobook: async () => SAMPLE_PAYLOAD,
    });

    render(
      <PlayerProvider>
        <PlayerHarness />
      </PlayerProvider>
    );

    await user.click(screen.getByRole("button", { name: "Load session" }));

    await waitFor(() => {
      expect(screen.getByTestId("has-payload")).toHaveTextContent("yes");
    });

    // Starts in mini (PlayerProvider.play sets mode "mini").
    expect(screen.getByLabelText("Expand player")).toBeInTheDocument();

    const audioNodes = () => document.querySelectorAll("audio");
    expect(audioNodes().length).toBe(1);
    const audioMini = audioNodes()[0];
    const loadMock = HTMLMediaElement.prototype.load as unknown as ReturnType<
      typeof vi.fn
    >;
    const loadsAfterSession = loadMock.mock.calls.length;

    // mini → expanded
    await user.click(screen.getByLabelText("Expand player"));
    await waitFor(() => {
      expect(screen.getByLabelText("Collapse")).toBeInTheDocument();
    });
    expect(audioNodes().length).toBe(1);
    expect(audioNodes()[0]).toBe(audioMini);
    // Mode change alone must not force a media reload.
    expect(loadMock.mock.calls.length).toBe(loadsAfterSession);

    // expanded → mini
    await user.click(screen.getByLabelText("Collapse"));
    await waitFor(() => {
      expect(screen.getByLabelText("Expand player")).toBeInTheDocument();
    });
    expect(audioNodes().length).toBe(1);
    expect(audioNodes()[0]).toBe(audioMini);
    expect(loadMock.mock.calls.length).toBe(loadsAfterSession);
  });

  it("close hides chrome and removes the audio element", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    installSanCitroMock({
      playAudiobook: async () => SAMPLE_PAYLOAD,
      saveAudiobookProgress: save,
    });

    render(
      <PlayerProvider>
        <PlayerHarness />
      </PlayerProvider>
    );

    await user.click(screen.getByRole("button", { name: "Load session" }));
    await waitFor(() => {
      expect(document.querySelectorAll("audio").length).toBe(1);
    });

    await user.click(screen.getByLabelText("Close player"));
    await waitFor(() => {
      expect(document.querySelectorAll("audio").length).toBe(0);
    });
    expect(screen.queryByLabelText("Expand player")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Collapse")).not.toBeInTheDocument();
  });
});
