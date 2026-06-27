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
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

import {
  getSettings,
  updateSettings,
  reloadConfig,
  getDiagnostics,
} from "@/lib/api-client";
import {
  trackInteraction, trackSettingsChange, trackFeatureDiscovery,
  incrementEngagement, trackBridgeCall,
} from "@/lib/telemetry";
import type { DiagnosticResult } from "@/types";

export default function SettingsPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Form state
  const [outDir, setOutDir] = useState("");
  const [concurrency, setConcurrency] = useState("4");
  const [proxiesText, setProxiesText] = useState("");

  // Diagnostics
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult[]>([]);
  const [isRunningDiag, setIsRunningDiag] = useState(false);

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

  const handleSave = async () => {
    incrementEngagement("settingsChanges");
    trackFeatureDiscovery("settings_save");
    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

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

      setSaveSuccess(true);
      if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
      saveSuccessTimer.current = setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleReloadConfig = async () => {
    setIsReloading(true);
    setError(null);
    try {
      const updated = await reloadConfig();
      setOutDir(updated.out_dir);
      setConcurrency(String(updated.concurrency));
      setProxiesText(updated.proxies.join(", "));
      setSaveSuccess(true);
      if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
      saveSuccessTimer.current = setTimeout(() => setSaveSuccess(false), 3000);
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

    try {
      const results = await getDiagnostics();
      setDiagnostics(results);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Diagnostics failed"
      );
    } finally {
      setIsRunningDiag(false);
    }
  };

  function diagIcon(status: DiagnosticResult["status"]) {
    switch (status) {
      case "ok":
        return <CheckCircle2Icon className="size-4 text-green-500" />;
      case "fail":
        return <XCircleIcon className="size-4 text-destructive" />;
      case "warn":
        return <AlertTriangleIcon className="size-4 text-yellow-500" />;
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // If the initial load failed and we have no data, show an error-only state
  if (error && !outDir) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Configure application settings</p>
        </div>
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure application settings
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {saveSuccess && (
        <div className="rounded-lg border border-green-500/50 bg-green-500/10 p-3 text-sm text-green-600 dark:text-green-400">
          Settings saved successfully
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
            <Input
              id="out_dir"
              value={outDir}
              onChange={(e) => setOutDir(e.target.value)}
              placeholder="/path/to/downloads"
              className="font-mono text-xs"
              disabled={isSaving}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="concurrency">Concurrency</Label>
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
              Number of simultaneous downloads (1-32)
            </p>
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
              Comma-separated list of proxy URLs
            </p>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={isSaving || isReloading}>
              {isSaving ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <SaveIcon className="size-4" />
              )}
              Save Settings
            </Button>
            <Button
              variant="outline"
              onClick={handleReloadConfig}
              disabled={isSaving || isReloading}
              title="Apply saved config changes without restarting (e.g. concurrency updates)"
            >
              {isReloading ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
              Reload Config
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
          <Button
            variant="outline"
            onClick={handleRunDiagnostics}
            disabled={isRunningDiag}
          >
            {isRunningDiag ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <PlayIcon className="size-4" />
            )}
            Run Diagnostics
          </Button>

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
    </div>
  );
}
