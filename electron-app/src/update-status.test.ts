// Unit tests for the pure Update status reducer. Run with:
//   npx tsc && node --test dist/update-status.test.js
// (no Electron / electron-updater imports)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_UPDATE_STATUS,
  clampPercent,
  reduceUpdateStatus,
  type UpdateEvent,
  type UpdateStatus,
} from './update-status';

function fold(
  events: UpdateEvent[],
  start: UpdateStatus = INITIAL_UPDATE_STATUS
): UpdateStatus {
  return events.reduce((s, e) => reduceUpdateStatus(s, e), start);
}

// --- clampPercent -----------------------------------------------------------

test('clampPercent: finite in-range passes through', () => {
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(42.5), 42.5);
  assert.equal(clampPercent(100), 100);
});

test('clampPercent: out-of-range and non-finite', () => {
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(undefined), undefined);
  assert.equal(clampPercent(Number.NaN), undefined);
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), undefined);
});

// --- normal sequences -------------------------------------------------------

test('normal sequence: idle → checking → available → downloading → downloaded', () => {
  const status = fold([
    { type: 'check-started' },
    { type: 'available', version: '1.2.5' },
    { type: 'download-progress', percent: 10 },
    { type: 'download-progress', percent: 90 },
    { type: 'downloaded', version: '1.2.5' },
  ]);
  assert.deepEqual(status, {
    status: 'downloaded',
    version: '1.2.5',
  });
});

test('direct available → downloaded (skip progress events)', () => {
  const status = fold([
    { type: 'check-started' },
    { type: 'available', version: '2.0.0' },
    { type: 'downloaded', version: '2.0.0' },
  ]);
  assert.deepEqual(status, { status: 'downloaded', version: '2.0.0' });
});

test('not-available after check', () => {
  const status = fold([
    { type: 'check-started' },
    { type: 'not-available', message: 'Updates only available in the installed build' },
  ]);
  assert.deepEqual(status, {
    status: 'not-available',
    message: 'Updates only available in the installed build',
  });
});

test('not-available without message omits message field', () => {
  const status = fold([{ type: 'check-started' }, { type: 'not-available' }]);
  assert.deepEqual(status, { status: 'not-available' });
  assert.equal('message' in status, false);
});

// --- version retention ------------------------------------------------------

test('download-progress retains version known from available', () => {
  const status = fold([
    { type: 'available', version: '1.3.0' },
    { type: 'download-progress', percent: 33 },
  ]);
  assert.equal(status.status, 'downloading');
  assert.equal(status.version, '1.3.0');
  assert.equal(status.percent, 33);
});

test('downloaded falls back to previously known version', () => {
  const status = fold([
    { type: 'available', version: '1.4.0' },
    { type: 'download-progress', percent: 100 },
    { type: 'downloaded' },
  ]);
  assert.deepEqual(status, { status: 'downloaded', version: '1.4.0' });
});

test('progress event version overrides retained version', () => {
  const status = fold([
    { type: 'available', version: '1.0.0' },
    { type: 'download-progress', percent: 5, version: '1.0.1' },
  ]);
  assert.equal(status.version, '1.0.1');
});

// --- percent clamping -------------------------------------------------------

test('download-progress clamps percent to 0–100', () => {
  assert.equal(
    fold([{ type: 'download-progress', percent: -1 }]).percent,
    0
  );
  assert.equal(
    fold([{ type: 'download-progress', percent: 101 }]).percent,
    100
  );
  const missing = fold([{ type: 'download-progress' }]);
  assert.equal(missing.status, 'downloading');
  assert.equal('percent' in missing, false);
});

// --- late / stale events ----------------------------------------------------

test('late progress must not downgrade downloaded', () => {
  const ready = fold([
    { type: 'available', version: '1.2.5' },
    { type: 'downloaded', version: '1.2.5' },
  ]);
  const afterStale = reduceUpdateStatus(ready, {
    type: 'download-progress',
    percent: 99,
  });
  assert.deepEqual(afterStale, ready);
  assert.equal(afterStale.status, 'downloaded');
});

test('repeated downloaded events stay downloaded', () => {
  const status = fold([
    { type: 'downloaded', version: '1.0.0' },
    { type: 'downloaded', version: '1.0.0' },
  ]);
  assert.deepEqual(status, { status: 'downloaded', version: '1.0.0' });
});

// --- errors and retry / check-again -----------------------------------------

test('error yields readable message', () => {
  const status = fold([
    { type: 'check-started' },
    { type: 'error', message: 'net::ERR_CONNECTION_REFUSED' },
  ]);
  assert.deepEqual(status, {
    status: 'error',
    message: 'net::ERR_CONNECTION_REFUSED',
  });
});

test('error with empty message falls back to Unknown update error', () => {
  const status = reduceUpdateStatus(INITIAL_UPDATE_STATUS, {
    type: 'error',
    message: '   ',
  });
  assert.equal(status.status, 'error');
  assert.equal(status.message, 'Unknown update error');
});

test('check-started after error returns to checking (retry)', () => {
  const status = fold([
    { type: 'error', message: 'boom' },
    { type: 'check-started' },
    { type: 'available', version: '9.9.9' },
  ]);
  assert.deepEqual(status, { status: 'available', version: '9.9.9' });
});

test('check-started from downloaded allows check-again', () => {
  const status = fold([
    { type: 'downloaded', version: '1.0.0' },
    { type: 'check-started' },
  ]);
  assert.deepEqual(status, { status: 'checking' });
});

test('check-started from not-available returns to checking', () => {
  const status = fold([
    { type: 'not-available' },
    { type: 'check-started' },
  ]);
  assert.deepEqual(status, { status: 'checking' });
});

// --- reset ------------------------------------------------------------------

test('reset returns to idle from any state', () => {
  const fromError = fold([
    { type: 'error', message: 'x' },
    { type: 'reset' },
  ]);
  assert.deepEqual(fromError, { status: 'idle' });

  const fromDl = fold([
    { type: 'downloaded', version: '1' },
    { type: 'reset' },
  ]);
  assert.deepEqual(fromDl, { status: 'idle' });
});

// --- missing optionals / initial --------------------------------------------

test('INITIAL_UPDATE_STATUS is idle', () => {
  assert.deepEqual(INITIAL_UPDATE_STATUS, { status: 'idle' });
});

test('available without version omits version field', () => {
  const status = reduceUpdateStatus(INITIAL_UPDATE_STATUS, {
    type: 'available',
  });
  assert.deepEqual(status, { status: 'available' });
  assert.equal('version' in status, false);
});

test('table: applying each terminal-ish event yields expected snapshot', () => {
  const cases: Array<{ event: UpdateEvent; expect: UpdateStatus }> = [
    {
      event: { type: 'available', version: '1.0.0' },
      expect: { status: 'available', version: '1.0.0' },
    },
    {
      event: { type: 'download-progress', percent: 50, version: '1.0.0' },
      expect: { status: 'downloading', percent: 50, version: '1.0.0' },
    },
    {
      event: { type: 'downloaded', version: '1.0.0' },
      expect: { status: 'downloaded', version: '1.0.0' },
    },
    {
      event: { type: 'not-available', message: 'up to date' },
      expect: { status: 'not-available', message: 'up to date' },
    },
    {
      event: { type: 'error', message: 'fail' },
      expect: { status: 'error', message: 'fail' },
    },
  ];
  for (const { event, expect } of cases) {
    assert.deepEqual(
      reduceUpdateStatus(INITIAL_UPDATE_STATUS, event),
      expect,
      `event ${event.type}`
    );
  }
});
