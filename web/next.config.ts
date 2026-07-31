import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root also has package-lock.json (Fallow tooling only). Keep Turbopack
// rooted on web/ so Next does not treat the monorepo tooling root as the app root.
const webRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Static export for embedding in Electron's san-citro:// protocol handler.
  // No server-side features (API routes, SSR data fetching, middleware) are available.
  output: "export",
  // Required for output: "export" — Next.js Image Optimization requires a server.
  images: { unoptimized: true },
  reactCompiler: true,
  turbopack: {
    root: webRoot,
  },
};

export default nextConfig;
