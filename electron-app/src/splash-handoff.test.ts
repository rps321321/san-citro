// Unit tests for one-shot splash handoff. Run with:
//   npx tsc && node --test dist/splash-handoff.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSplashHandoff,
  SPLASH_HANDOFF_TIMEOUT_MS,
} from './splash-handoff';

test('splash handoff timeout is finite and > ready-to-show gap', () => {
  assert.ok(SPLASH_HANDOFF_TIMEOUT_MS >= 10_000);
  assert.ok(SPLASH_HANDOFF_TIMEOUT_MS <= 30_000);
});

test('first complete closes splash, shows main, records reason', () => {
  const calls: string[] = [];
  const handoff = createSplashHandoff({
    closeSplash: () => calls.push('close'),
    showMain: () => calls.push('show'),
    log: (m) => calls.push(m),
  });

  assert.equal(handoff.isDone, false);
  assert.equal(handoff.reason, null);

  const first = handoff.complete('renderer-ready');
  assert.equal(first, true);
  assert.equal(handoff.isDone, true);
  assert.equal(handoff.reason, 'renderer-ready');
  assert.deepEqual(calls, [
    '[main] Splash handoff: renderer-ready',
    'close',
    'show',
  ]);
});

test('second complete is a no-op (timeout after ready)', () => {
  let closes = 0;
  let shows = 0;
  const handoff = createSplashHandoff({
    closeSplash: () => {
      closes += 1;
    },
    showMain: () => {
      shows += 1;
    },
  });

  assert.equal(handoff.complete('renderer-ready'), true);
  assert.equal(handoff.complete('timeout'), false);
  assert.equal(handoff.complete('did-fail-load'), false);
  assert.equal(closes, 1);
  assert.equal(shows, 1);
  assert.equal(handoff.reason, 'renderer-ready');
});

test('errors in close/show do not throw or block isDone', () => {
  const handoff = createSplashHandoff({
    closeSplash: () => {
      throw new Error('splash gone');
    },
    showMain: () => {
      throw new Error('win gone');
    },
  });
  assert.equal(handoff.complete('render-process-gone'), true);
  assert.equal(handoff.isDone, true);
  assert.equal(handoff.reason, 'render-process-gone');
});
