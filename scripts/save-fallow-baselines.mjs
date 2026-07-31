/**
 * Regenerate committed Fallow baselines for staged adoption.
 *
 * Run from repo root after reviewing inventory findings:
 *   npm run fallow:baselines
 *
 * Baselines live outside .fallow/ (gitignored cache) so CI and contributors
 * compare against the same committed debt ledger.
 */
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "fallow-baselines");
mkdirSync(outDir, { recursive: true });

const fallowBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "fallow.cmd" : "fallow"
);

const targets = [
  ["dead-code", path.join(outDir, "dead-code.json")],
  ["health", path.join(outDir, "health.json")],
  ["dupes", path.join(outDir, "dupes.json")],
];

let failed = false;
for (const [cmd, outPath] of targets) {
  console.log(`Saving ${cmd} baseline → ${path.relative(root, outPath)}`);
  const result = spawnSync(
    fallowBin,
    [cmd, "--save-baseline", outPath, "--quiet"],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" }
  );
  if (result.status !== 0 && result.status !== 1) {
    // fallow exits 1 when findings exist; that is expected while baselining.
    // Exit 2+ is a real failure.
    console.error(`fallow ${cmd} failed with exit ${result.status}`);
    failed = true;
  }
}

if (failed) {
  process.exit(2);
}
console.log("Baselines updated under fallow-baselines/");
