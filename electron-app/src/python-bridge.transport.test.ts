/**
 * Deterministic transport errors for the Python JSON-RPC bridge (#11).
 *
 * Covers: unknown methods (RPC error), timeouts, process exit, malformed
 * responses, and late responses. Pure PendingRpcTable — no Electron spawn.
 *
 * Run (after tsc): node --test dist/python-bridge.transport.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PendingRpcTable,
  REQUEST_TIMEOUT_MS,
  TRANSPORT_NOT_RUNNING,
  TRANSPORT_PROCESS_EXITED,
  TRANSPORT_SHUTTING_DOWN,
  classifyRpcResponse,
  transportMalformedMessage,
  transportRpcErrorMessage,
  transportTimeoutMessage,
} from './python-bridge';

// ---------------------------------------------------------------------------
// Message helpers (stable strings callers / logs can rely on)
// ---------------------------------------------------------------------------

test('timeout / exit / not-running / RPC error messages are deterministic', () => {
  assert.equal(
    transportTimeoutMessage('search'),
    `Request search timed out after ${REQUEST_TIMEOUT_MS}ms`
  );
  assert.equal(
    transportTimeoutMessage('get_history', 5_000),
    'Request get_history timed out after 5000ms'
  );
  assert.equal(TRANSPORT_PROCESS_EXITED, 'Python bridge process exited');
  assert.equal(TRANSPORT_NOT_RUNNING, 'Python bridge is not running');
  assert.equal(TRANSPORT_SHUTTING_DOWN, 'Bridge is shutting down');
  // Unknown method arrives as JSON-RPC -32601 from Python.
  assert.equal(
    transportRpcErrorMessage(-32601, 'Method not found: nope'),
    '[-32601] Method not found: nope'
  );
  assert.equal(transportMalformedMessage(7), 'Malformed JSON-RPC response for id 7');
});

test('classifyRpcResponse: result / error / malformed', () => {
  assert.equal(classifyRpcResponse({ result: { ok: true } }), 'result');
  assert.equal(classifyRpcResponse({ result: null }), 'result');
  assert.equal(
    classifyRpcResponse({ error: { code: -32601, message: 'Method not found: x' } }),
    'error'
  );
  assert.equal(classifyRpcResponse({}), 'malformed');
  assert.equal(classifyRpcResponse({ error: { code: 'x', message: 'y' } as never }), 'malformed');
  assert.equal(classifyRpcResponse({ error: { code: 1 } as never }), 'malformed');
});

// ---------------------------------------------------------------------------
// PendingRpcTable correlation
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('unknown method (JSON-RPC error) rejects with [code] message', async () => {
  const table = new PendingRpcTable();
  const d = deferred();
  table.add(1, 'nope', d.resolve, d.reject, setTimeout(() => {}, 60_000));

  const outcome = table.settle({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32601, message: 'Method not found: nope' },
  });
  assert.equal(outcome, 'rejected');
  assert.equal(table.size, 0);

  await assert.rejects(d.promise, (err: Error) => {
    assert.equal(err.message, '[-32601] Method not found: nope');
    return true;
  });
});

test('successful result resolves and clears pending', async () => {
  const table = new PendingRpcTable();
  const d = deferred();
  table.add(2, 'search', d.resolve, d.reject, setTimeout(() => {}, 60_000));

  const outcome = table.settle({
    jsonrpc: '2.0',
    id: 2,
    result: { items: [] },
  });
  assert.equal(outcome, 'resolved');
  assert.deepEqual(await d.promise, { items: [] });
  assert.equal(table.size, 0);
});

test('malformed response (no result/error) rejects deterministically', async () => {
  const table = new PendingRpcTable();
  const d = deferred();
  table.add(3, 'get_stats', d.resolve, d.reject, setTimeout(() => {}, 60_000));

  const outcome = table.settle({
    jsonrpc: '2.0',
    id: 3,
    // neither result nor error
  } as never);
  assert.equal(outcome, 'rejected');

  await assert.rejects(d.promise, (err: Error) => {
    assert.equal(err.message, transportMalformedMessage(3));
    return true;
  });
});

test('late response (unknown id) is a no-op and does not throw', async () => {
  const table = new PendingRpcTable();
  // Simulate: request timed out and was deleted; response arrives late.
  const outcome = table.settle({
    jsonrpc: '2.0',
    id: 99,
    result: { too: 'late' },
  });
  assert.equal(outcome, 'late');
  assert.equal(table.size, 0);

  // A second late settle stays late (idempotent).
  assert.equal(
    table.settle({ jsonrpc: '2.0', id: 99, result: { still: 'late' } }),
    'late'
  );
});

test('timeout path: delete + timeout message leaves late response harmless', async () => {
  const table = new PendingRpcTable();
  const d = deferred();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    table.delete(4);
    d.reject(new Error(transportTimeoutMessage('list_library')));
  }, 20);
  table.add(4, 'list_library', d.resolve, d.reject, timer);

  await assert.rejects(d.promise, (err: Error) => {
    assert.match(err.message, /list_library timed out/);
    return true;
  });
  assert.equal(timedOut, true);
  assert.equal(table.size, 0);

  // Late success after timeout must not re-settle (no unhandled rejection).
  assert.equal(
    table.settle({ jsonrpc: '2.0', id: 4, result: { ok: true } }),
    'late'
  );
});

test('process exit rejects all pending with the same deterministic error', async () => {
  const table = new PendingRpcTable();
  const a = deferred();
  const b = deferred();
  table.add(10, 'search', a.resolve, a.reject, setTimeout(() => {}, 60_000));
  table.add(11, 'get_downloads', b.resolve, b.reject, setTimeout(() => {}, 60_000));
  assert.equal(table.size, 2);

  table.rejectAll(new Error(TRANSPORT_PROCESS_EXITED));
  assert.equal(table.size, 0);

  await assert.rejects(a.promise, (err: Error) => {
    assert.equal(err.message, TRANSPORT_PROCESS_EXITED);
    return true;
  });
  await assert.rejects(b.promise, (err: Error) => {
    assert.equal(err.message, TRANSPORT_PROCESS_EXITED);
    return true;
  });
});

test('shutdown rejects all pending with shutting-down message', async () => {
  const table = new PendingRpcTable();
  const d = deferred();
  table.add(1, 'run_diagnostics', d.resolve, d.reject, setTimeout(() => {}, 60_000));
  table.rejectAll(new Error(TRANSPORT_SHUTTING_DOWN));
  await assert.rejects(d.promise, (err: Error) => {
    assert.equal(err.message, TRANSPORT_SHUTTING_DOWN);
    return true;
  });
});
