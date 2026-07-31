import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TITLEBAR_HEIGHT_PX,
  TITLEBAR_OVERLAY_WIDTH_PX,
  TITLEBAR_OVERLAY,
  resolveTitlebarOverlay,
} from "./titlebar.ts";

describe("titlebar overlay contract (#53)", () => {
  it("uses a 36px band and a single explicit overlay safe-area width", () => {
    assert.equal(TITLEBAR_HEIGHT_PX, 36);
    assert.equal(TITLEBAR_OVERLAY_WIDTH_PX, 138);
  });

  it("exposes solid hex pairs for light and dark (no alpha, no probe)", () => {
    for (const theme of ["light", "dark"] as const) {
      const { color, symbolColor } = TITLEBAR_OVERLAY[theme];
      assert.match(color, /^#[0-9a-f]{6}$/i);
      assert.match(symbolColor, /^#[0-9a-f]{6}$/i);
      assert.notEqual(color, symbolColor);
    }
  });

  it("resolves light explicitly and defaults unknown/undefined to dark", () => {
    assert.deepEqual(resolveTitlebarOverlay("light"), TITLEBAR_OVERLAY.light);
    assert.deepEqual(resolveTitlebarOverlay("dark"), TITLEBAR_OVERLAY.dark);
    assert.deepEqual(resolveTitlebarOverlay(undefined), TITLEBAR_OVERLAY.dark);
    assert.deepEqual(resolveTitlebarOverlay("system"), TITLEBAR_OVERLAY.dark);
  });

  it("keeps dark fill near black so minimize/maximize stay neutral on charcoal", () => {
    // Contract: dark overlay matches opaque title-bar, not a blue-tinted patch.
    assert.equal(TITLEBAR_OVERLAY.dark.color, "#0a0a0a");
    assert.equal(TITLEBAR_OVERLAY.light.color, "#ffffff");
  });
});
