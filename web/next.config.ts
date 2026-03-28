import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for embedding in Electron's san-citro:// protocol handler.
  // No server-side features (API routes, SSR data fetching, middleware) are available.
  output: "export",
  // Required for output: "export" — Next.js Image Optimization requires a server.
  images: { unoptimized: true },
  reactCompiler: true,
};

export default nextConfig;
