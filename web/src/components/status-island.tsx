"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "react-router";
import { DownloadIcon, Loader2Icon, CheckCircle2Icon } from "lucide-react";
import { useDownloadStream } from "@/lib/use-sse";
import { onAudiobookStatus } from "@/lib/api-client";

// Title-bar "Dynamic Island" (ADR-0011): a glass status pill that appears on
// activity (downloading / processing → ready) and settles to nothing when idle.
// Click → Downloads. Centered via FLEX and animated with OPACITY ONLY — never a
// transform on the glass or an ancestor (the containing-block trap blanks
// backdrop-filter). Owns the live status the old download badge used to show.
export function StatusIsland() {
  const navigate = useNavigate();
  const { downloads } = useDownloadStream();
  const [processing, setProcessing] = useState(0);
  const [justReady, setJustReady] = useState(false);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const procSet = new Set<string>();
    const clearReadyTimer = () => {
      clearTimeout(readyTimer.current ?? undefined);
      readyTimer.current = null;
    };
    const unsubscribe = onAudiobookStatus(({ md5, status }) => {
      if (status === "processing") {
        procSet.add(md5);
        setProcessing(procSet.size);
        return;
      }
      if (procSet.delete(md5)) setProcessing(procSet.size);
      if (status !== "ready") return;
      setJustReady(true);
      clearReadyTimer();
      readyTimer.current = setTimeout(() => setJustReady(false), 4000);
    });
    return () => {
      unsubscribe();
      clearReadyTimer();
    };
  }, []);

  const activeDownloads = Array.from(downloads.values()).filter(
    (d) => d.status === "downloading" || d.status === "started" || d.status === "queued"
  ).length;

  let icon: React.ReactNode = null;
  let label = "";
  if (processing > 0) {
    icon = <Loader2Icon className="size-3.5 animate-spin text-primary" />;
    label = processing > 1 ? `Processing ${processing}` : "Processing…";
  } else if (activeDownloads > 0) {
    icon = <DownloadIcon className="size-3.5" />;
    label = activeDownloads > 1 ? `Downloading ${activeDownloads}` : "Downloading…";
  } else if (justReady) {
    icon = <CheckCircle2Icon className="size-3.5 text-primary" />;
    label = "Ready";
  }

  const visible = label !== "";

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 right-[140px] z-50 flex items-center justify-center">
      <AnimatePresence>
        {visible && (
          <motion.button
            key="island"
            type="button"
            onClick={() => navigate("/activity")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            aria-label={label}
            className="app-region-no-drag glass pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-foreground shadow-sm"
          >
            {icon}
            <span className="tabular-nums">{label}</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
