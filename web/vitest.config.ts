import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Component-test harness (ticket #26).
 *
 * Only picks up *.test.tsx so existing pure node:test suites
 * (src/lib/*.test.ts) keep running via `npx tsx --test …`.
 * No @vitejs/plugin-react (babel peer conflicts with Next); Vitest
 * transforms JSX via its default pipeline.
 */
export default defineConfig({
  root: rootDir,
  test: {
    environment: "jsdom",
    setupFiles: [path.join(rootDir, "src/test/setup.ts")],
    include: ["src/**/*.test.tsx"],
    exclude: ["node_modules", "out", ".next"],
    css: false,
  },
  resolve: {
    alias: {
      "@": path.join(rootDir, "src"),
      // Pin a single React copy (avoids invalid-hook-call from hoisting).
      react: path.join(rootDir, "node_modules/react"),
      "react-dom": path.join(rootDir, "node_modules/react-dom"),
      "react/jsx-runtime": path.join(
        rootDir,
        "node_modules/react/jsx-runtime.js"
      ),
      "react/jsx-dev-runtime": path.join(
        rootDir,
        "node_modules/react/jsx-dev-runtime.js"
      ),
    },
  },
});
