/**
 * Reader File display-name policy (ticket #30 / CONTEXT Readable format; ADR-0014).
 *
 * Foliate detects format from the File name; empty filename + bare md5 fails.
 * Run: npx tsx --test src/lib/reader-file-name.test.ts  (from web/)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readerFileDisplayName } from "./reader-file-name";

const MD5 = "26ef9f66be1268c180004715e19b1b30";

describe("readerFileDisplayName", () => {
  test("extension set + empty filename → name includes extension (md5.ext)", () => {
    const name = readerFileDisplayName({
      md5: MD5,
      filename: null,
      extension: "epub",
    });
    assert.equal(name, `${MD5}.epub`);
    assert.ok(name.endsWith(".epub"));
  });

  test("extension set + blank filename + title → title.ext", () => {
    const name = readerFileDisplayName({
      md5: MD5,
      filename: "   ",
      extension: "mobi",
      title: "Dracula",
    });
    assert.equal(name, "Dracula.mobi");
  });

  test("full filename present is preferred over extension/title", () => {
    const name = readerFileDisplayName({
      md5: MD5,
      filename: "Title - Author.azw3",
      extension: "epub",
      title: "Other Title",
    });
    assert.equal(name, "Title - Author.azw3");
  });

  test("filename empty and extension missing → md5 only", () => {
    const name = readerFileDisplayName({
      md5: MD5,
      filename: "",
      extension: null,
    });
    assert.equal(name, MD5);
  });

  test("bare extension with leading dot / case is normalized", () => {
    const name = readerFileDisplayName({
      md5: MD5,
      filename: null,
      extension: ".AZW3",
    });
    assert.equal(name, `${MD5}.azw3`);
  });
});
