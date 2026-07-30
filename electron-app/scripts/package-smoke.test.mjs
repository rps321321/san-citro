/**
 * Unit tests for package-smoke (fixture-based; no electron-builder).
 * Run: node --test scripts/package-smoke.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  runPackageSmoke,
  setupBaseName,
  yamlScalar,
  yamlUrlLines,
  parseArgs,
} from "./package-smoke.mjs";

describe("setupBaseName", () => {
  it("uses hyphenated stable Installer name", () => {
    assert.equal(setupBaseName("1.2.0"), "San-Citro-Setup-1.2.0");
  });
});

describe("yaml helpers", () => {
  const sample = `version: 1.2.0
files:
  - url: San-Citro-Setup-1.2.0.exe
    sha512: abc
    size: 1
path: San-Citro-Setup-1.2.0.exe
sha512: abc
`;

  it("reads version and path", () => {
    assert.equal(yamlScalar(sample, "version"), "1.2.0");
    assert.equal(yamlScalar(sample, "path"), "San-Citro-Setup-1.2.0.exe");
  });

  it("reads url list", () => {
    assert.deepEqual(yamlUrlLines(sample), ["San-Citro-Setup-1.2.0.exe"]);
  });
});

describe("runPackageSmoke", () => {
  /** @type {string} */
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-smoke-"));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails when dir is empty", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    const r = runPackageSmoke({ dir: empty, version: "1.2.0" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("Setup missing")));
    assert.ok(r.errors.some((e) => e.includes("latest.yml")));
  });

  it("fails when latest.yml path uses spaces (legacy name)", () => {
    const bad = path.join(tmp, "legacy");
    fs.mkdirSync(bad);
    const name = "San-Citro-Setup-1.2.0.exe";
    fs.writeFileSync(path.join(bad, name), "x");
    fs.writeFileSync(path.join(bad, `${name}.blockmap`), "y");
    fs.writeFileSync(
      path.join(bad, "latest.yml"),
      `version: 1.2.0
files:
  - url: San Citro Setup 1.2.0.exe
path: San Citro Setup 1.2.0.exe
`
    );
    const r = runPackageSmoke({ dir: bad, version: "1.2.0" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("path mismatch")));
  });

  it("passes on well-formed Release artifacts", () => {
    const good = path.join(tmp, "good");
    fs.mkdirSync(good);
    const name = "San-Citro-Setup-9.9.9.exe";
    fs.writeFileSync(path.join(good, name), Buffer.alloc(64, 1));
    fs.writeFileSync(path.join(good, `${name}.blockmap`), Buffer.alloc(16, 2));
    fs.writeFileSync(
      path.join(good, "latest.yml"),
      `version: 9.9.9
files:
  - url: ${name}
    sha512: deadbeef
    size: 64
path: ${name}
sha512: deadbeef
releaseDate: '2026-01-01T00:00:00.000Z'
`
    );
    const r = runPackageSmoke({ dir: good, version: "9.9.9" });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.ok(r.checks.length >= 3);
  });

  it("fails on version mismatch in feed", () => {
    const d = path.join(tmp, "ver");
    fs.mkdirSync(d);
    const name = "San-Citro-Setup-1.0.0.exe";
    fs.writeFileSync(path.join(d, name), "x");
    fs.writeFileSync(path.join(d, `${name}.blockmap`), "y");
    fs.writeFileSync(
      path.join(d, "latest.yml"),
      `version: 2.0.0
files:
  - url: ${name}
path: ${name}
`
    );
    const r = runPackageSmoke({ dir: d, version: "1.0.0" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("version mismatch")));
  });
});

describe("parseArgs", () => {
  it("reads --version", () => {
    const o = parseArgs(["--version", "3.1.4", "--dir", os.tmpdir()]);
    assert.equal(o.version, "3.1.4");
    assert.ok(o.dir.length > 0);
  });
});
