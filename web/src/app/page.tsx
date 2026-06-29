"use client";

import { useEffect, useState } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router";

import AppShell from "@/components/app-shell";
import SearchPage from "@/routes/search";
import LibraryPage from "@/routes/library";
import ActivityPage from "@/routes/activity";
import SettingsPage from "@/routes/settings";
import ReaderPage from "@/routes/reader";

// The renderer is a hash-routed SPA (ADR-0013): one index.html shell mounts the
// HashRouter and the former Next pages become route components under AppShell's
// <Outlet>. HashRouter is client-only, so gate on mount — Next prerenders this to
// an empty shell, then the client hydrates and boots the router.
export default function Page() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

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
