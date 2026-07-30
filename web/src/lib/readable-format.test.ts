/**
 * Readable format policy tests (CONTEXT: Readable format; ADR-0014).
 *
 * Run: npx tsx --test src/lib/readable-format.test.ts  (from web/)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  READABLE_EXTENSIONS,
  extensionOf,
  isReadable,
} from "./readable-format";

describe("READABLE_EXTENSIONS", () => {
  test("matches foliate multi-format set (no PDF)", () => {
    assert.deepEqual([...READABLE_EXTENSIONS].sort(), [
      "azw",
      "azw3",
      "cbz",
      "epub",
      "fb2",
      "fbz",
      "mobi",
    ]);
  });
});

describe("extensionOf", () => {
  const cases: [string | null | undefined, string][] = [
    [null, ""],
    [undefined, ""],
    ["", ""],
    ["  ", ""],
    ["epub", "epub"],
    ["EPUB", "epub"],
    [" .mobi ", "mobi"],
    ["book.epub", "epub"],
    ["Title - Author.azw3", "azw3"],
    ["C:\\\\Downloads\\\\San Citro\\\\book.fb2", "fb2"],
    ["path/to/comic.CBZ", "cbz"],
  ];

  for (const [input, expected] of cases) {
    test(`extensionOf(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      assert.equal(extensionOf(input), expected);
    });
  }
});

describe("isReadable", () => {
  const trueCases = [
    "epub",
    "mobi",
    "azw3",
    "azw",
    "fb2",
    "fbz",
    "cbz",
    "EPUB",
    "book.epub",
    "Title - Author.mobi",
    "file.AZW3",
    "kindle.azw",
    "story.fb2",
    "pack.fbz",
    "comic.cbz",
    "C:\\\\lib\\\\x.epub",
    "path/to/y.mobi",
  ];

  const falseCases = [
    null,
    undefined,
    "",
    "   ",
    "pdf",
    "txt",
    "djvu",
    "cbr",
    "zip",
    "mp3",
    "m4b",
    "book.pdf",
    "archive.zip",
    "audio.mp3",
    "noext",
  ];

  for (const input of trueCases) {
    test(`isReadable(${JSON.stringify(input)}) is true`, () => {
      assert.equal(isReadable(input), true);
    });
  }

  for (const input of falseCases) {
    test(`isReadable(${JSON.stringify(input)}) is false`, () => {
      assert.equal(isReadable(input), false);
    });
  }
});
