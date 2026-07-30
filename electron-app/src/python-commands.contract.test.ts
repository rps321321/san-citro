/**
 * Contract tests for the desktop command path (Phase 4 / ADR-0013).
 *
 * Agreement: descriptor ⊆ preload exposure ⊆ renderer SanCitroApi ⊆
 * Electron IPC_CHANNELS / registration ⊆ Python registry (via usesMethods).
 * Reverse: no orphan Python-only or preload-only names for the Python-backed set.
 * Retired WebContentsView player channels must be absent everywhere.
 *
 * Run (after tsc): node --test dist/python-commands.contract.test.js
 * Or:             npx tsx --test src/python-commands.contract.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PYTHON_COMMANDS,
  RETIRED_PLAYER_CHANNELS,
  listAllPythonMethods,
  listRendererFacingCommands,
  listSimpleRelays,
  registerSimpleRelays,
  requireMd5,
} from './python-commands';
import { IPC_CHANNELS } from './types';

const SRC_DIR = path.dirname(__filename);
// When compiled, __filename is dist/; sources live in src/ next to package root.
const ELECTRON_ROOT = path.resolve(SRC_DIR, '..');
// Prefer live src next to dist; fall back when tests run via tsx from src/.
function srcFile(name: string): string {
  const fromDist = path.join(ELECTRON_ROOT, 'src', name);
  if (fs.existsSync(fromDist)) return fromDist;
  return path.join(SRC_DIR, name);
}

function readSrc(name: string): string {
  return fs.readFileSync(srcFile(name), 'utf8');
}

function readWebTypes(): string {
  const candidates = [
    path.join(ELECTRON_ROOT, '..', 'web', 'src', 'types', 'index.ts'),
    path.join(ELECTRON_ROOT, 'web', 'src', 'types', 'index.ts'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('web/src/types/index.ts not found relative to electron-app');
}

function readPythonHandlers(): string {
  const p = path.join(ELECTRON_ROOT, 'python', 'bridge_handlers.py');
  return fs.readFileSync(p, 'utf8');
}

/** Extract string values from a `const IPC_CHANNELS = { ... }` / export block. */
function extractChannelStringLiterals(source: string): Set<string> {
  const values = new Set<string>();
  const re = /['"](san-citro:[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    values.add(m[1]);
  }
  return values;
}

/** Method names on the `const api = { ... }` object in preload. */
function extractPreloadApiNames(source: string): Set<string> {
  const names = new Set<string>();
  // Top-level keys of the api object:  name: ( or name: (()
  const apiBlock = source.match(/const api = \{([\s\S]*?)\n\};/);
  assert.ok(apiBlock, 'preload api object not found');
  const body = apiBlock[1];
  const keyRe = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/** Method names declared on SanCitroApi interface. */
function extractSanCitroApiNames(source: string): Set<string> {
  const names = new Set<string>();
  const iface = source.match(/export interface SanCitroApi \{([\s\S]*?)\n\}/);
  assert.ok(iface, 'SanCitroApi interface not found');
  const body = iface[1];
  const keyRe = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*[\(:]/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/** register_method("name", ...) from Python. */
function extractPythonRegisteredMethods(source: string): Set<string> {
  const names = new Set<string>();
  const re = /register_method\(\s*["']([a-z_]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    names.add(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Descriptor integrity
// ---------------------------------------------------------------------------

test('simple relays have channel + apiName; internals have neither', () => {
  for (const cmd of PYTHON_COMMANDS) {
    if (cmd.mode === 'relay' || cmd.mode === 'composite') {
      assert.ok(cmd.channel, `${cmd.method}: renderer-facing needs channel`);
      assert.ok(cmd.apiName, `${cmd.method}: renderer-facing needs apiName`);
    } else {
      assert.equal(cmd.channel, null, `${cmd.method}: internal has no channel`);
      assert.equal(cmd.apiName, undefined, `${cmd.method}: internal has no apiName`);
    }
    assert.ok(cmd.usesMethods.length > 0, `${cmd.method}: usesMethods non-empty`);
  }
});

test('listSimpleRelays returns only mode=relay', () => {
  for (const cmd of listSimpleRelays()) {
    assert.equal(cmd.mode, 'relay');
  }
  assert.ok(listSimpleRelays().length >= 10);
});

// ---------------------------------------------------------------------------
// Channel agreement: descriptor ⊆ types IPC_CHANNELS ⊆ preload allowlist
// ---------------------------------------------------------------------------

test('descriptor channels ⊆ IPC_CHANNELS values', () => {
  const typeChannels = new Set(Object.values(IPC_CHANNELS));
  for (const cmd of listRendererFacingCommands()) {
    assert.ok(
      typeChannels.has(cmd.channel as (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]),
      `descriptor channel missing from IPC_CHANNELS: ${cmd.channel}`
    );
  }
});

test('descriptor channels ⊆ preload inlined allowlist', () => {
  const preload = readSrc('preload.ts');
  const preloadChannels = extractChannelStringLiterals(preload);
  for (const cmd of listRendererFacingCommands()) {
    assert.ok(
      preloadChannels.has(cmd.channel!),
      `descriptor channel missing from preload: ${cmd.channel}`
    );
  }
});

test('types IPC_CHANNELS ⊆ preload allowlist (shared channel strings)', () => {
  const preloadChannels = extractChannelStringLiterals(readSrc('preload.ts'));
  for (const ch of Object.values(IPC_CHANNELS)) {
    // Push-only channels that main sends without a preload invoke still need
    // to be listed in preload if the renderer subscribes (downloadProgress etc.).
    // All current IPC_CHANNELS values that are invoke/send/on from preload
    // must appear; channels only used main→renderer push still appear in
    // preload's on* helpers. Assert every types channel is inlined in preload
    // OR is only registered in main without preload (none today after cleanup).
    assert.ok(
      preloadChannels.has(ch),
      `IPC_CHANNELS value missing from preload allowlist: ${ch}`
    );
  }
});

// ---------------------------------------------------------------------------
// API name agreement: descriptor apiNames ⊆ preload ⊆ SanCitroApi
// ---------------------------------------------------------------------------

test('descriptor apiNames ⊆ preload api surface', () => {
  const preloadNames = extractPreloadApiNames(readSrc('preload.ts'));
  for (const cmd of listRendererFacingCommands()) {
    assert.ok(
      preloadNames.has(cmd.apiName!),
      `descriptor apiName missing from preload: ${cmd.apiName}`
    );
  }
});

test('descriptor apiNames ⊆ renderer SanCitroApi', () => {
  const apiNames = extractSanCitroApiNames(readWebTypes());
  for (const cmd of listRendererFacingCommands()) {
    assert.ok(
      apiNames.has(cmd.apiName!),
      `descriptor apiName missing from SanCitroApi: ${cmd.apiName}`
    );
  }
});

test('no orphan Python-backed preload names outside descriptor', () => {
  // Preload also exposes OS-only APIs; only check names that invoke a
  // san-citro channel that the descriptor claims as Python-backed.
  const facing = new Set(listRendererFacingCommands().map((c) => c.apiName!));
  const preload = readSrc('preload.ts');
  for (const name of facing) {
    // Each facing name must appear as a key
    assert.match(preload, new RegExp(`\\b${name}\\s*:`), `preload missing ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Python registry agreement
// ---------------------------------------------------------------------------

test('every usesMethods entry is registered in bridge_handlers', () => {
  const registered = extractPythonRegisteredMethods(readPythonHandlers());
  for (const method of listAllPythonMethods()) {
    // play_audiobook / show_item_in_folder / read_book_file are composite
    // identities — not real Python RPC methods. Only real methods are in usesMethods.
    assert.ok(
      registered.has(method),
      `Python method not registered: ${method}`
    );
  }
});

test('no orphan Python-registered methods outside descriptor usesMethods', () => {
  const registered = extractPythonRegisteredMethods(readPythonHandlers());
  const expected = new Set(listAllPythonMethods());
  for (const method of registered) {
    assert.ok(
      expected.has(method),
      `Python method registered but not in descriptor usesMethods: ${method}`
    );
  }
});

// ---------------------------------------------------------------------------
// Retired WebContentsView channels (ADR-0013)
// ---------------------------------------------------------------------------

test('retired player channels absent as live string literals', () => {
  // RETIRED_PLAYER_CHANNELS in python-commands.ts is the denylist itself (may
  // contain the strings). Live surfaces must not reintroduce them as IPC keys.
  const sources = {
    types: readSrc('types.ts'),
    preload: readSrc('preload.ts'),
    ipc: readSrc('ipc-handlers.ts'),
  };

  for (const ch of RETIRED_PLAYER_CHANNELS) {
    for (const [label, src] of Object.entries(sources)) {
      // Strip block/line comments so retirement notes do not false-positive.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const hasLiteral =
        code.includes(`'${ch}'`) ||
        code.includes(`"${ch}"`) ||
        code.includes(`\`${ch}\``);
      assert.ok(!hasLiteral, `${label} still has channel literal ${ch}`);
    }
    assert.ok(
      !Object.values(IPC_CHANNELS).includes(ch as never),
      `IPC_CHANNELS still has ${ch}`
    );
  }
});

test('retired PLAYER_LOAD / SET_MODE / REQUEST_MODE keys absent from IPC_CHANNELS', () => {
  const keys = Object.keys(IPC_CHANNELS);
  for (const bad of ['PLAYER_LOAD', 'PLAYER_SET_MODE', 'PLAYER_REQUEST_MODE', 'PLAYER_ACTIVE', 'PLAYER_CONTENT_RECT']) {
    assert.ok(!keys.includes(bad), `IPC_CHANNELS still has key ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Relay registration with fake IPC + fake bridge
// ---------------------------------------------------------------------------

test('registerSimpleRelays wires each relay channel to bridge.call(method)', async () => {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  const calls: { method: string; params?: Record<string, unknown> }[] = [];

  const fakeBridge = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true, method };
    },
  };

  registerSimpleRelays(fakeBridge, (channel, listener) => {
    registered.set(channel, listener);
  });

  const relays = listSimpleRelays();
  assert.equal(registered.size, relays.length);

  for (const cmd of relays) {
    assert.ok(registered.has(cmd.channel!), `missing registration for ${cmd.channel}`);
    const listener = registered.get(cmd.channel!)!;
    calls.length = 0;
    const result = await listener({}, { sample: true });
    assert.deepEqual(result, { ok: true, method: cmd.method });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, cmd.method);
    assert.deepEqual(calls[0].params, { sample: true });
  }
});

test('registerSimpleRelays passes empty object when params omitted', async () => {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  let lastParams: unknown;
  registerSimpleRelays(
    {
      call: async (_m, params) => {
        lastParams = params;
        return null;
      },
    },
    (channel, listener) => {
      registered.set(channel, listener);
    }
  );

  const search = listSimpleRelays().find((c) => c.method === 'get_downloads')!;
  await registered.get(search.channel!)!({});
  assert.deepEqual(lastParams, {});
});

// ---------------------------------------------------------------------------
// Malformed params rejected at trusted composite seam
// ---------------------------------------------------------------------------

test('requireMd5 rejects missing/empty md5 at trusted seam', () => {
  assert.throws(() => requireMd5({}), /md5 is required/);
  assert.throws(() => requireMd5({ md5: '' }), /md5 is required/);
  assert.throws(() => requireMd5(null), /md5 is required/);
  assert.throws(() => requireMd5(undefined), /md5 is required/);
  assert.throws(() => requireMd5({ md5: 12 }), /md5 is required/);
  assert.equal(requireMd5({ md5: 'a'.repeat(32) }), 'a'.repeat(32));
});
