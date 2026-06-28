// Unit tests for the pure parseRange helper. Run with:
//   node --test dist/media-protocol.test.js   (after `tsc`)
// or  npx tsx --test src/media-protocol.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from './media-protocol';

const SIZE = 1000;

test('no header -> 200 full body', () => {
  const r = parseRange(undefined, SIZE);
  assert.equal(r.status, 200);
  assert.equal(r.start, 0);
  assert.equal(r.end, SIZE - 1);
});

test('null header -> 200 full body', () => {
  const r = parseRange(null, SIZE);
  assert.equal(r.status, 200);
});

test('bytes=0-99 -> 206 length 100', () => {
  const r = parseRange('bytes=0-99', SIZE);
  assert.equal(r.status, 206);
  assert.equal(r.start, 0);
  assert.equal(r.end, 99);
  assert.equal(r.end - r.start + 1, 100);
});

test('bytes=-500 -> 206 suffix (last 500 bytes)', () => {
  const r = parseRange('bytes=-500', SIZE);
  assert.equal(r.status, 206);
  assert.equal(r.start, 500);
  assert.equal(r.end, 999);
  assert.equal(r.end - r.start + 1, 500);
});

test('bytes=100- -> 206 from 100 to size-1', () => {
  const r = parseRange('bytes=100-', SIZE);
  assert.equal(r.status, 206);
  assert.equal(r.start, 100);
  assert.equal(r.end, SIZE - 1);
});

test('start >= size -> 416', () => {
  const r = parseRange('bytes=1000-1100', SIZE);
  assert.equal(r.status, 416);
});

test('malformed header -> 416', () => {
  assert.equal(parseRange('chunks=0-10', SIZE).status, 416);
  assert.equal(parseRange('bytes=abc', SIZE).status, 416);
  assert.equal(parseRange('bytes=-', SIZE).status, 416);
});

test('end past size is clamped to size-1', () => {
  const r = parseRange('bytes=900-5000', SIZE);
  assert.equal(r.status, 206);
  assert.equal(r.start, 900);
  assert.equal(r.end, SIZE - 1);
});
