#!/usr/bin/env node
/**
 * Package smoke — gate Installer Release artifacts after electron-builder.
 *
 * Asserts (external packaging outcomes only):
 *   - Setup exe exists, non-empty, stable name San-Citro-Setup-{version}.exe
 *   - Blockmap exists for the Setup
 *   - latest.yml exists, version matches, path/url reference the same Setup name
 *
 * Usage:
 *   node scripts/package-smoke.mjs --dir release --version 1.2.0
 *   node scripts/package-smoke.mjs --dir release --version-from package.json
 *
 * Exit 0 on pass, 1 on fail. Printable lines are human-readable failures.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, "..");

/**
 * @param {string[]} argv
 * @returns {{ dir: string, version: string }}
 */
export function parseArgs(argv) {
  let dir = path.join(electronRoot, "release");
  let version = null;
  let versionFrom = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" && argv[i + 1]) {
      dir = path.resolve(argv[++i]);
    } else if (a === "--version" && argv[i + 1]) {
      version = argv[++i];
    } else if (a === "--version-from" && argv[i + 1]) {
      versionFrom = path.resolve(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (versionFrom) {
    const pkg = JSON.parse(fs.readFileSync(versionFrom, "utf8"));
    version = String(pkg.version);
  }
  if (!version) {
    const pkgPath = path.join(electronRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    version = String(pkg.version);
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid version (expected semver X.Y.Z): ${version}`);
  }
  return { dir, version };
}

function printHelp() {
  console.log(`Usage: node package-smoke.mjs [--dir DIR] [--version X.Y.Z | --version-from package.json]
Stable Setup name: San-Citro-Setup-{version}.exe (ADR-0015)`);
}

/**
 * Minimal YAML field grab for electron-builder latest.yml (flat keys we need).
 * @param {string} text
 * @param {string} key
 * @returns {string | null}
 */
export function yamlScalar(text, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function yamlUrlLines(text) {
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*url:\s*(.+)\s*$/);
    if (m) {
      let u = m[1].trim();
      if ((u.startsWith("'") && u.endsWith("'")) || (u.startsWith('"') && u.endsWith('"'))) {
        u = u.slice(1, -1);
      }
      urls.push(u);
    }
  }
  return urls;
}

/**
 * Expected stable artifact base name (no extension).
 * @param {string} version
 */
export function setupBaseName(version) {
  return `San-Citro-Setup-${version}`;
}

/**
 * @param {{ dir: string, version: string }} opts
 * @returns {{ ok: boolean, errors: string[], checks: string[] }}
 */
export function runPackageSmoke(opts) {
  const { dir, version } = opts;
  const errors = [];
  const checks = [];
  const base = setupBaseName(version);
  const setupName = `${base}.exe`;
  const blockmapName = `${setupName}.blockmap`;
  const setupPath = path.join(dir, setupName);
  const blockmapPath = path.join(dir, blockmapName);
  const latestPath = path.join(dir, "latest.yml");

  if (!fs.existsSync(dir)) {
    errors.push(`Release dir missing: ${dir}`);
    return { ok: false, errors, checks };
  }

  if (!fs.existsSync(setupPath)) {
    errors.push(`Setup missing: ${setupName}`);
  } else {
    const st = fs.statSync(setupPath);
    if (!st.isFile() || st.size <= 0) {
      errors.push(`Setup empty or not a file: ${setupName}`);
    } else {
      checks.push(`Setup ok: ${setupName} (${st.size} bytes)`);
    }
  }

  if (!fs.existsSync(blockmapPath)) {
    errors.push(`Blockmap missing: ${blockmapName}`);
  } else {
    const st = fs.statSync(blockmapPath);
    if (!st.isFile() || st.size <= 0) {
      errors.push(`Blockmap empty: ${blockmapName}`);
    } else {
      checks.push(`Blockmap ok: ${blockmapName}`);
    }
  }

  if (!fs.existsSync(latestPath)) {
    errors.push("Update feed missing: latest.yml");
  } else {
    const text = fs.readFileSync(latestPath, "utf8");
    const feedVersion = yamlScalar(text, "version");
    const feedPath = yamlScalar(text, "path");
    const urls = yamlUrlLines(text);

    if (feedVersion !== version) {
      errors.push(
        `latest.yml version mismatch: got ${JSON.stringify(feedVersion)}, expected ${JSON.stringify(version)}`
      );
    } else {
      checks.push(`latest.yml version=${feedVersion}`);
    }

    if (feedPath !== setupName) {
      errors.push(
        `latest.yml path mismatch: got ${JSON.stringify(feedPath)}, expected ${JSON.stringify(setupName)}`
      );
    } else {
      checks.push(`latest.yml path=${feedPath}`);
    }

    if (!urls.includes(setupName)) {
      errors.push(
        `latest.yml files[].url missing Setup name ${setupName} (got: ${urls.join(", ") || "none"})`
      );
    } else {
      checks.push(`latest.yml url lists ${setupName}`);
    }
  }

  return { ok: errors.length === 0, errors, checks };
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = runPackageSmoke(opts);
    for (const c of result.checks) console.log(`ok  ${c}`);
    for (const e of result.errors) console.error(`FAIL ${e}`);
    if (!result.ok) {
      console.error(`package-smoke FAILED for version ${opts.version} in ${opts.dir}`);
      process.exit(1);
    }
    console.log(`package-smoke PASSED version=${opts.version}`);
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
