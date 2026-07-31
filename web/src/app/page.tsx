"use client";

import { useEffect, useState, type ReactNode } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router";

import AppShell from "@/components/app-shell";
import { StartupShell } from "@/components/startup-shell";
import SearchPage from "@/routes/search";
import LibraryPage from "@/routes/library";
import ActivityPage from "@/routes/activity";
import SettingsPage from "@/routes/settings";
import ReaderPage from "@/routes/reader";

/** Fire-and-forget: Electron keeps splash until this (issue #62). */
function notifyRendererReady(): void {
  try {
    window.sanCitro?.notifyRendererReady?.();
  } catch {
    // Browser / tests without preload.
  }
}

/**
 * Pure mount gate: shell fallback vs HashRouter. Exported for tests so the
 * prerender contract is assertable without fighting React effect flush timing.
 */
export function ClientRoutedApp({ ready }: { ready: boolean }): ReactNode {
  if (!ready) {
    return <StartupShell />;
  }

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/search" replace />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/downloads" element={<Navigate to="/activity" replace />} />
          <Route path="/history" element={<Navigate to="/activity" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/reader" element={<ReaderPage />} />
          <Route path="*" element={<Navigate to="/search" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

// The renderer is a hash-routed SPA (ADR-0013): one index.html shell mounts the
// HashRouter and the former Next pages become route components under AppShell's
// <Outlet>. HashRouter is client-only, so gate on mount — Next prerenders this
// with StartupShell (not null), then the client hydrates and boots the router.
export default function Page() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // After the first client paint of the shell-shaped fallback, signal main so
  // splash → main handoff follows meaningful chrome rather than document load.
  useEffect(() => {
    let cancelled = false;
    let innerId = 0;
    const outerId = requestAnimationFrame(() => {
      innerId = requestAnimationFrame(() => {
        if (!cancelled) notifyRendererReady();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(outerId);
      if (innerId) cancelAnimationFrame(innerId);
    };
  }, []);

  return <ClientRoutedApp ready={mounted} />;
}
