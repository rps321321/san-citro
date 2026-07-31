/**
 * Status vocabulary seam tests (durable/history → public lifecycle).
 *
 * Run: npx tsx --test src/lib/status.test.ts  (from web/)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_DOWNLOAD_STATUSES,
  STATUS_LABELS,
  getStatusLabel,
  getStatusVariant,
  normalizeDownloadStatus,
} from "./status";

/** Table: durable or public input → expected public (or passthrough) value. */
const NORMALIZE_CASES: ReadonlyArray<readonly [string, string]> = [
  // public alphabet — identity
  ["queued", "queued"],
  ["downloading", "downloading"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  // durable / history-only
  ["started", "downloading"],
  ["interrupted", "interrupted"], // history-only; not coerced to live public
  // unknown — pass through
  ["unknown", "unknown"],
  ["", ""],
  ["bogus-status", "bogus-status"],
];

const LABEL_CASES: ReadonlyArray<readonly [string, string]> = [
  ["queued", "Queued"],
  ["downloading", "Downloading"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["started", "Downloading"],
  ["interrupted", "Interrupted"],
  ["weird", "weird"],
];

const VARIANT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["completed", "success"],
  ["failed", "destructive"],
  ["downloading", "default"],
  ["started", "default"], // durable → downloading → default
  ["queued", "outline"],
  ["cancelled", "outline"],
  ["interrupted", "outline"],
  ["unknown", "outline"],
];

describe("normalizeDownloadStatus (status vocabulary seam)", () => {
  for (const [input, expected] of NORMALIZE_CASES) {
    test(`normalize(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizeDownloadStatus(input), expected);
    });
  }

  test("public alphabet is exactly the five lifecycle statuses", () => {
    assert.deepEqual([...PUBLIC_DOWNLOAD_STATUSES].sort(), [
      "cancelled",
      "completed",
      "downloading",
      "failed",
      "queued",
    ]);
  });

  test("every public status is identity under normalize", () => {
    for (const s of PUBLIC_DOWNLOAD_STATUSES) {
      assert.equal(normalizeDownloadStatus(s), s);
    }
  });
});

describe("getStatusLabel", () => {
  for (const [input, expected] of LABEL_CASES) {
    test(`label(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      assert.equal(getStatusLabel(input), expected);
    });
  }

  test("STATUS_LABELS covers every public status", () => {
    for (const s of PUBLIC_DOWNLOAD_STATUSES) {
      assert.equal(typeof STATUS_LABELS[s], "string");
      assert.ok(STATUS_LABELS[s].length > 0);
    }
  });
});

describe("getStatusVariant", () => {
  for (const [input, expected] of VARIANT_CASES) {
    test(`variant(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      assert.equal(getStatusVariant(input), expected);
    });
  }
});

describe("no component-local started→downloading maps", () => {
  test("routes/components/contexts do not reimplement durable started coercion", () => {
    const webSrc = join(dirname(fileURLToPath(import.meta.url)), "..");
    const roots = ["routes", "components", "contexts"];
    // Local durable-status coercions that bypass @/lib/status.
    // Note: History sort keys use case "started" for started_at columns — not banned.
    const banned = [
      /status\s*===\s*["']started["']/,
      /status\s*==\s*["']started["']/,
      /["']started["']\s*===\s*status/,
      /["']started["']\s*==\s*status/,
      /\.status\s*===\s*["']started["']/,
      /status_raw\s*==\s*["']started["']/,
      /normalize\w*\([^)]*\)\s*===\s*["']started["']/,
    ];
    const offenders: string[] = [];

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          out.push(...walk(p));
        } else if (
          /\.(ts|tsx)$/.test(name) &&
          !name.endsWith(".test.ts") &&
          !name.endsWith(".test.tsx")
        ) {
          out.push(p);
        }
      }
      return out;
    }

    for (const root of roots) {
      const dir = join(webSrc, root);
      let files: string[] = [];
      try {
        files = walk(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const re of banned) {
          if (re.test(text)) {
            offenders.push(`${relative(webSrc, file)}: ${re}`);
          }
        }
      }
    }

    assert.deepEqual(offenders, [], `component-local started maps:\n${offenders.join("\n")}`);
  });
});
