// Unit tests for the main-side Update status owner. Run with:
//   npx tsc && node --test dist/update-status-owner.test.js
// (no Electron / electron-updater runtime)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUpdateStatusOwner,
  type AutoUpdaterAdapter,
  type UpdateStatusOwner,
} from './update-status-owner';
import type { UpdateStatus } from './types';

type Listener = (...args: unknown[]) => void;

function makeFakeUpdater(): AutoUpdaterAdapter & {
  emit(event: string, ...args: unknown[]): void;
  checkCalls: number;
  quitCalls: number;
} {
  const handlers = new Map<string, Listener[]>();
  const fake = {
    autoDownload: false,
    logger: undefined as unknown,
    checkCalls: 0,
    quitCalls: 0,
    on(event: string, listener: Listener): void {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
    },
    emit(event: string, ...args: unknown[]): void {
      for (const l of handlers.get(event) ?? []) l(...args);
    },
    async checkForUpdates(): Promise<unknown> {
      fake.checkCalls += 1;
      return undefined;
    },
    quitAndInstall(): void {
      fake.quitCalls += 1;
    },
  };
  return fake;
}

function collect(owner: UpdateStatusOwner): UpdateStatus[] {
  const seen: UpdateStatus[] = [];
  owner.subscribe((s) => {
    seen.push(s);
  });
  // Drop the hydrate snapshot so assertions focus on subsequent transitions.
  seen.length = 0;
  return seen;
}

// --- snapshot + subscribe hydration -----------------------------------------

test('initial snapshot is idle', () => {
  const owner = createUpdateStatusOwner({ isPackaged: false });
  assert.deepEqual(owner.getSnapshot(), { status: 'idle' });
});

test('late subscriber is hydrated with current snapshot', () => {
  const owner = createUpdateStatusOwner({ isPackaged: true });
  owner.dispatch({ type: 'available', version: '1.2.5' });

  let hydrated: UpdateStatus | null = null;
  owner.subscribe((s) => {
    hydrated = s;
  });
  assert.deepEqual(hydrated, { status: 'available', version: '1.2.5' });
});

test('subscribe returns unsubscribe that stops further notifies', () => {
  const owner = createUpdateStatusOwner({ isPackaged: true });
  const seen: UpdateStatus[] = [];
  const unsub = owner.subscribe((s) => seen.push(s));
  seen.length = 0;
  unsub();
  owner.dispatch({ type: 'check-started' });
  assert.equal(seen.length, 0);
});

// --- one notification per real transition -----------------------------------

test('one notification per transition; late progress after downloaded skips', () => {
  const owner = createUpdateStatusOwner({ isPackaged: true });
  const seen = collect(owner);

  owner.dispatch({ type: 'check-started' });
  owner.dispatch({ type: 'available', version: '2.0.0' });
  owner.dispatch({ type: 'download-progress', percent: 50 });
  owner.dispatch({ type: 'downloaded', version: '2.0.0' });
  const afterDownloaded = seen.length;
  owner.dispatch({ type: 'download-progress', percent: 99 }); // must not notify

  assert.equal(seen.length, afterDownloaded);
  assert.deepEqual(owner.getSnapshot(), {
    status: 'downloaded',
    version: '2.0.0',
  });
  assert.deepEqual(
    seen.map((s) => s.status),
    ['checking', 'available', 'downloading', 'downloaded']
  );
});

// --- check() shared by launch + manual --------------------------------------

test('non-packaged check dispatches live not-available snapshot', async () => {
  const owner = createUpdateStatusOwner({ isPackaged: false });
  const seen = collect(owner);

  const status = await owner.check();
  assert.equal(status.status, 'not-available');
  assert.match(status.message ?? '', /installed build/i);
  assert.deepEqual(owner.getSnapshot(), status);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 'not-available');
});

test('packaged check calls adapter once; launch and manual share check()', async () => {
  const fake = makeFakeUpdater();
  const owner = createUpdateStatusOwner({
    isPackaged: true,
    autoUpdater: fake,
  });
  owner.start();

  await owner.check();
  await owner.check();
  assert.equal(fake.checkCalls, 2);
});

test('packaged start wires library events into pure transitions', () => {
  const fake = makeFakeUpdater();
  const owner = createUpdateStatusOwner({
    isPackaged: true,
    autoUpdater: fake,
  });
  const seen = collect(owner);
  owner.start();

  fake.emit('checking-for-update');
  fake.emit('update-available', { version: '3.1.0' });
  fake.emit('download-progress', { percent: 42 });
  fake.emit('update-downloaded', { version: '3.1.0' });

  assert.deepEqual(owner.getSnapshot(), {
    status: 'downloaded',
    version: '3.1.0',
  });
  assert.deepEqual(
    seen.map((s) => s.status),
    ['checking', 'available', 'downloading', 'downloaded']
  );
  assert.equal(fake.autoDownload, true);
});

test('start is idempotent (listeners not double-wired)', () => {
  const fake = makeFakeUpdater();
  const owner = createUpdateStatusOwner({
    isPackaged: true,
    autoUpdater: fake,
  });
  const seen = collect(owner);
  owner.start();
  owner.start();
  fake.emit('checking-for-update');
  // Would be 2 if listeners stacked.
  assert.equal(seen.filter((s) => s.status === 'checking').length, 1);
});

test('library error event becomes error snapshot', () => {
  const fake = makeFakeUpdater();
  const owner = createUpdateStatusOwner({
    isPackaged: true,
    autoUpdater: fake,
  });
  owner.start();
  fake.emit('error', new Error('net::ERR_FAILED'));
  assert.deepEqual(owner.getSnapshot(), {
    status: 'error',
    message: 'net::ERR_FAILED',
  });
});

test('update-not-available from library', () => {
  const fake = makeFakeUpdater();
  const owner = createUpdateStatusOwner({
    isPackaged: true,
    autoUpdater: fake,
  });
  owner.start();
  fake.emit('checking-for-update');
  fake.emit('update-not-available');
  assert.deepEqual(owner.getSnapshot(), { status: 'not-available' });
});

// --- quitAndInstall logging + adapter call ----------------------------------

test('quitAndInstall logs status and calls adapter when packaged', () => {
  const fake = makeFakeUpdater();
  const logs: unknown[][] = [];
  const owner = createUpdateStatusOwner({
    isPackaged: true,
    autoUpdater: fake,
    log: {
      info: (...args) => logs.push(args),
      error: () => {},
    },
  });
  owner.dispatch({ type: 'downloaded', version: '1.0.0' });
  owner.quitAndInstall();

  assert.equal(fake.quitCalls, 1);
  assert.ok(
    logs.some(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('quitAndInstall requested')
    )
  );
});

test('quitAndInstall logs but does not call adapter when not packaged', () => {
  const fake = makeFakeUpdater();
  const logs: unknown[][] = [];
  const owner = createUpdateStatusOwner({
    isPackaged: false,
    autoUpdater: fake,
    log: {
      info: (...args) => logs.push(args),
      error: () => {},
    },
  });
  owner.quitAndInstall();
  assert.equal(fake.quitCalls, 0);
  assert.ok(
    logs.some(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('quitAndInstall requested')
    )
  );
});

// --- tray/renderer are pure subscribers (no transition logic in owner fan-out)

test('multiple subscribers each receive the same transition', () => {
  const owner = createUpdateStatusOwner({ isPackaged: true });
  const tray: UpdateStatus[] = [];
  const renderer: UpdateStatus[] = [];
  owner.subscribe((s) => tray.push(s));
  owner.subscribe((s) => renderer.push(s));
  tray.length = 0;
  renderer.length = 0;

  owner.dispatch({ type: 'available', version: '9.9.9' });
  assert.deepEqual(tray, [{ status: 'available', version: '9.9.9' }]);
  assert.deepEqual(renderer, [{ status: 'available', version: '9.9.9' }]);
});
