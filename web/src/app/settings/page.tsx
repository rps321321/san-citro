"use client";

import { useEffect, useRef, useState } from "react";
import {
  SettingsIcon,
  SaveIcon,
  LoaderIcon,
  PlayIcon,
  RefreshCwIcon,
  CheckCircle2Icon,
  XCircleIcon,
  AlertTriangleIcon,
  FolderOpenIcon,
  InfoIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import {
  getSettings,
  updateSettings,
  reloadConfig,
  getDiagnostics,
  showOpenDialog,
  getAppVersion,
  checkForUpdates,
} from "@/lib/api-client";
import {
  trackInteraction, trackSettingsChange, trackFeatureDiscovery,
  incrementEngagement, trackBridgeCall,
} from "@/lib/telemetry";
import type { DiagnosticResult, UpdateStatus } from "@/types";

export default function SettingsPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct copy for Save vs Reload — null means no banner shown.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // Graceful dismiss: we keep the message rendered while fading it out.
  const [successVisible, setSuccessVisible] = useState(false);
  // Inline validation error for the output directory (blocks save when empty).
  const [outDirError, setOutDirError] = useState<string | null>(null);

  // Form state
  const [outDir, setOutDir] = useState("");
  const [concurrency, setConcurrency] = useState("4");
  const [proxiesText, setProxiesText] = useState("");

  // Inline concurrency clamp feedback (1-32) shown live while typing.
  const concurrencyNum = Number(concurrency);
  const concurrencyNote =
    concurrency.trim() === "" || !Number.isFinite(concurrencyNum)
      ? null
      : concurrencyNum > 32
        ? "Will be capped at 32"
        : concurrencyNum < 1
          ? "Minimum is 1"
          : null;

  // Diagnostics
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult[]>([]);
  const [isRunningDiag, setIsRunningDiag] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  // About & updates
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  // Timer ref to avoid setState-on-unmounted-component warnings
  const saveSuccessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getSettings();
        if (!cancelled) {
          setOutDir(data.out_dir);
          setConcurrency(String(data.concurrency));
          setProxiesText(data.proxies.join(", "));
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load settings"
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAppVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {
        // Version is informational only — leave null if unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheckForUpdates = async () => {
    trackInteraction("check_for_updates", "settings");
    setIsCheckingUpdate(true);
    try {
      const status = await checkForUpdates();
      setUpdateStatus(status);
    } catch (err) {
      setUpdateStatus({
        status: "error",
        message: err instanceof Error ? err.message : "Update check failed",
      });
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const dismissSuccess = () => {
    setSuccessVisible(false);
    // Wait for the fade-out (150ms) then clear the message to remove from DOM
    saveSuccessTimer.current = setTimeout(() => setSuccessMessage(null), 160);
  };

  const showSuccess = (msg: string) => {
    setSuccessMessage(msg);
    // Trigger visible on the next frame so the CSS transition fires
    requestAnimationFrame(() => setSuccessVisible(true));
    if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
    saveSuccessTimer.current = setTimeout(dismissSuccess, 3000);
  };

  const handleBrowse = async () => {
    trackInteraction("browse_out_dir", "settings");
    try {
      const dir = await showOpenDialog();
      if (dir) {
        setOutDir(dir);
        setOutDirError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Folder picker failed");
    }
  };

  const handleSave = async () => {
    setOutDirError(null);
    if (!outDir.trim()) {
      setOutDirError("Output directory is required.");
      return;
    }

    incrementEngagement("settingsChanges");
    trackFeatureDiscovery("settings_save");
    setIsSaving(true);
    setError(null);
    setSuccessVisible(false);
    setSuccessMessage(null);

    try {
      const proxies = proxiesText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const parsed = Number(concurrency);
      const clampedConcurrency =
        Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 32) : 4;

      const updated = await updateSettings({
        out_dir: outDir,
        concurrency: clampedConcurrency,
        proxies,
      });

      setOutDir(updated.out_dir);
      setConcurrency(String(updated.concurrency));
      setProxiesText(updated.proxies.join(", "));

      showSuccess("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleReloadConfig = async () => {
    setIsReloading(true);
    setError(null);
    setSuccessVisible(false);
    setSuccessMessage(null);
    try {
      const updated = await reloadConfig();
      setOutDir(updated.out_dir);
      setConcurrency(String(updated.concurrency));
      setProxiesText(updated.proxies.join(", "));
      setOutDirError(null);
      showSuccess("Config reloaded from file.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reload failed");
    } finally {
      setIsReloading(false);
    }
  };

  const handleRunDiagnostics = async () => {
    incrementEngagement("diagnosticsRun");
    trackFeatureDiscovery("diagnostics");
    trackInteraction("run_diagnostics", "settings");
    setIsRunningDiag(true);
    setDiagnostics([]);
    setDiagError(null);

    try {
      const results = await getDiagnostics();
      setDiagnostics(results);
    } catch (err) {
      setDiagError(
        err instanceof Error ? err.message : "Diagnostics failed — try running again"
      );
    } finally {
      setIsRunningDiag(false);
    }
  };

  function diagIcon(status: DiagnosticResult["status"]) {
    switch (status) {
      case "ok":
        return (
          <span role="img" aria-label="OK">
            <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
          </span>
        );
      case "fail":
        return (
          <span role="img" aria-label="Failed">
            <XCircleIcon className="size-4 text-destructive" aria-hidden="true" />
          </span>
        );
      case "warn":
        return (
          <span role="img" aria-label="Warning">
            <AlertTriangleIcon className="size-4 text-warning" aria-hidden="true" />
          </span>
        );
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl" aria-busy="true" aria-label="Loading settings">
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-28" />
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Output directory field skeleton */}
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <div className="flex gap-2">
                <Skeleton className="h-9 flex-1 rounded-md" />
                <Skeleton className="h-9 w-24 rounded-md" />
              </div>
            </div>
            {/* Concurrency field skeleton */}
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-9 w-24 rounded-md" />
              <Skeleton className="h-3 w-48" />
            </div>
            {/* Proxies field skeleton */}
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-3 w-56" />
            </div>
            {/* Buttons skeleton */}
            <div className="flex gap-2">
              <Skeleton className="h-9 w-28 rounded-md" />
              <Skeleton className="h-9 w-36 rounded-md" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // If the initial load failed and we have no data, show an error-only state
  if (error && !outDir) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {error && <Banner variant="error" message={error} />}

      {successMessage && (
        <div
          className="transition-[opacity,transform] duration-150 ease-out motion-safe:duration-150"
          style={{ opacity: successVisible ? 1 : 0, transform: successVisible ? "translateY(0)" : "translateY(-4px)" }}
        >
          <Banner
            variant="success"
            message={successMessage}
            onDismiss={dismissSuccess}
          />
        </div>
      )}

      {/* Settings form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <SettingsIcon className="size-4" />
            Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="out_dir">Output Directory</Label>
            <div className="flex gap-2">
              <Input
                id="out_dir"
                value={outDir}
                onChange={(e) => {
                  setOutDir(e.target.value);
                  if (e.target.value.trim()) setOutDirError(null);
                }}
                placeholder="C:\Users\YourName\Downloads"
                className="font-mono text-xs"
                disabled={isSaving}
                aria-invalid={outDirError ? true : undefined}
                aria-describedby={outDirError ? "out_dir-error" : undefined}
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleBrowse}
                disabled={isSaving}
                className="shrink-0"
              >
                <FolderOpenIcon className="size-4" />
                Browse…
              </Button>
            </div>
            {outDirError && (
              <p id="out_dir-error" role="alert" className="text-xs text-destructive">
                {outDirError}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="concurrency">Simultaneous downloads</Label>
            <Input
              id="concurrency"
              type="number"
              min={1}
              max={32}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              className="w-24"
              disabled={isSaving}
            />
            <p className="text-xs text-muted-foreground">
              How many files to download at the same time (1–32). Higher values use more bandwidth.
            </p>
            {concurrencyNote && (
              <p role="alert" className="text-xs text-warning">
                {concurrencyNote}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="proxies">Proxies</Label>
            <Input
              id="proxies"
              value={proxiesText}
              onChange={(e) => setProxiesText(e.target.value)}
              placeholder="http://proxy1:8080, http://proxy2:8080"
              className="font-mono text-xs"
              disabled={isSaving}
            />
            <p className="text-xs text-muted-foreground">
              Optional. Comma-separated HTTP/SOCKS proxy URLs — useful if Anna&apos;s Archive is blocked in your region.
            </p>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={isSaving || isReloading} aria-busy={isSaving}>
              {isSaving ? (
                <>
                  <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
                  <span className="sr-only">Saving…</span>
                </>
              ) : (
                <SaveIcon className="size-4" aria-hidden="true" />
              )}
              {isSaving ? "Saving…" : "Save Settings"}
            </Button>
            <Button
              variant="outline"
              onClick={handleReloadConfig}
              disabled={isSaving || isReloading}
              aria-busy={isReloading}
              title="Apply saved config changes without restarting (e.g. concurrency updates)"
            >
              {isReloading ? (
                <>
                  <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
                  <span className="sr-only">Reloading…</span>
                </>
              ) : (
                <RefreshCwIcon className="size-4" aria-hidden="true" />
              )}
              {isReloading ? "Reloading…" : "Reload from file"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Diagnostics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Diagnostics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Button
              variant="outline"
              onClick={handleRunDiagnostics}
              disabled={isRunningDiag}
              aria-busy={isRunningDiag}
            >
              {isRunningDiag ? (
                <>
                  <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
                  <span className="sr-only">Running diagnostics…</span>
                </>
              ) : (
                <PlayIcon className="size-4" aria-hidden="true" />
              )}
              {isRunningDiag ? "Running…" : "Run diagnostics"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Checks connectivity, Python bridge, and disk access.
            </p>
            {diagError && (
              <p role="alert" className="text-xs text-destructive">
                {diagError}
              </p>
            )}
          </div>

          {diagnostics.length > 0 && (
            <div className="space-y-2">
              {diagnostics.map((diag, i) => (
                <div
                  key={`${diag.name}-${i}`}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <div className="mt-0.5">{diagIcon(diag.status)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{diag.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {diag.message}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* About & updates */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <InfoIcon className="size-4" />
            About &amp; updates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono text-xs">{appVersion ?? "Unknown"}</span>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleCheckForUpdates}
              disabled={isCheckingUpdate}
              aria-busy={isCheckingUpdate}
            >
              {isCheckingUpdate ? (
                <>
                  <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
                  <span className="sr-only">Checking for updates…</span>
                </>
              ) : (
                <RefreshCwIcon className="size-4" aria-hidden="true" />
              )}
              {isCheckingUpdate ? "Checking…" : "Check for updates"}
            </Button>
            {updateStatus && (
              <span className="text-xs text-muted-foreground">
                {updateStatusLabel(updateStatus)}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function updateStatusLabel(s: UpdateStatus): string {
  switch (s.status) {
    case "checking":
      return "Checking…";
    case "available":
      return `Update available${s.version ? ` (v${s.version})` : ""}`;
    case "not-available":
      return "You're up to date";
    case "downloading":
      return `Downloading${s.percent != null ? ` ${Math.round(s.percent)}%` : "…"}`;
    case "downloaded":
      return "Update downloaded — restart to install";
    case "error":
      return s.message ?? "Update check failed";
    default:
      return "Idle";
  }
}
