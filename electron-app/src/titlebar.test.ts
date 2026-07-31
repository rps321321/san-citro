// Unit tests for the title-bar overlay contract. Run with:
//   npx tsc && node --test dist/titlebar.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TITLEBAR_OVERLAY,
  TITLEBAR_HEIGHT_PX,
  TITLEBAR_OVERLAY,
  TITLEBAR_OVERLAY_WIDTH_PX,
  resolveTitlebarOverlay,
} from './titlebar';

test('titlebar geometry: 36px height, 138px overlay safe area', () => {
  assert.equal(TITLEBAR_HEIGHT_PX, 36);
  assert.equal(TITLEBAR_OVERLAY_WIDTH_PX, 138);
});

test('default overlay matches dark theme (ThemeProvider default)', () => {
  assert.deepEqual(DEFAULT_TITLEBAR_OVERLAY, TITLEBAR_OVERLAY.dark);
  assert.equal(DEFAULT_TITLEBAR_OVERLAY.color, '#0a0a0a');
  assert.equal(DEFAULT_TITLEBAR_OVERLAY.symbolColor, '#fafafa');
});

test('resolveTitlebarOverlay: light explicit, else dark', () => {
  assert.deepEqual(resolveTitlebarOverlay('light'), TITLEBAR_OVERLAY.light);
  assert.deepEqual(resolveTitlebarOverlay('dark'), TITLEBAR_OVERLAY.dark);
  assert.deepEqual(resolveTitlebarOverlay(undefined), TITLEBAR_OVERLAY.dark);
});

test('overlay colors are opaque #rrggbb (Electron titleBarOverlay)', () => {
  for (const theme of ['light', 'dark'] as const) {
    const { color, symbolColor } = TITLEBAR_OVERLAY[theme];
    assert.match(color, /^#[0-9a-f]{6}$/i);
    assert.match(symbolColor, /^#[0-9a-f]{6}$/i);
  }
});
