import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // React-Compiler rules (eslint-plugin-react-hooks 7) are advisory here, not errors:
  // they flag setState-in-effect / ref-in-render patterns in code shipped in v1.2.0 that
  // the redesign rewrites anyway. Warn so they stay visible without blocking the lint gate.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored third-party source (foliate-js, ADR-0014) — not ours to lint.
    "src/vendor/**",
  ]),
]);

export default eslintConfig;
