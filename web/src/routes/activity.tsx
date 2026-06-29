"use client";

import DownloadsPage from "@/routes/downloads";
import HistoryPage from "@/routes/history";

// Activity = the unified transfer log (grill decision): active downloads
// (manage/cancel) stacked above history, merged into one route. Live status lives
// in the title-bar Dynamic Island; this is the full log. DownloadsPage in
// `embedded` mode renders nothing when there's no active transfer, so History
// sits flush below.
export default function ActivityPage() {
  return (
    <div className="space-y-8">
      <DownloadsPage embedded />
      <HistoryPage />
    </div>
  );
}
