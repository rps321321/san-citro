// Cross-platform discovery runner for Electron TypeScript unit tests.
// Finds all src/**/*.test.ts files and runs them via tsx --test.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(root, "src");

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

const files = walk(srcDir).sort();
if (files.length === 0) {
  console.error("No src/**/*.test.ts files found");
  process.exit(1);
}

console.log(
  `Running ${files.length} Electron unit test file(s):\n` +
    files.map((f) => `  - ${relative(root, f)}`).join("\n")
);

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { stdio: "inherit", cwd: root, env: process.env }
);

process.exit(result.status === null ? 1 : result.status);
