"use client";

import { useEffect } from "react";

/**
 * Global error boundary — catches errors thrown by the root layout itself
 * (ThemeProvider, SidebarProvider, etc.). Must render its own <html>/<body>
 * since the root layout may have failed, so theme tokens/CSS may be unavailable.
 * Colors come from an inline <style> driven by prefers-color-scheme.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError] Root layout error:", error);
  }, [error]);

  // Hide Python tracebacks and excessively long messages from the user.
  const safeMessage =
    error.message &&
    !error.message.includes("Traceback") &&
    error.message.length <= 200
      ? error.message
      : "An unexpected error occurred.";

  return (
    <html lang="en">
      <body>
        <style>{`
          .ge-body {
            font-family: ui-sans-serif, system-ui, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #ffffff;
            color: #0a0a0a;
          }
          .ge-msg { opacity: 0.7; }
          .ge-button {
            margin-top: 1.5rem;
            padding: 0.5rem 1rem;
            border: 1px solid #767676;
            border-radius: 0.375rem;
            background: transparent;
            color: inherit;
            cursor: pointer;
            font-size: 0.875rem;
          }
          @media (prefers-color-scheme: dark) {
            .ge-body { background: #0a0a0a; color: #fafafa; }
            .ge-button { border-color: #8f8f8f; }
          }
        `}</style>
        <div className="ge-body">
          <div style={{ textAlign: "center", padding: "2rem" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
              Something went wrong
            </h2>
            <p
              className="ge-msg"
              style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}
            >
              {safeMessage}
            </p>
            <button className="ge-button" onClick={reset}>
              Reload app
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
