"use client";

import { Banner } from "@/components/ui/alert";

export interface SearchNoticesProps {
  error: string | null;
  onDismissError: () => void;
  onRetrySearch: () => void;
  downloadSuccess: boolean;
  onDismissDownloadSuccess: () => void;
  downloadError: string | null;
  onDismissDownloadError: () => void;
}

/** Search + download banners. Presentational only. */
export function SearchNotices({
  error,
  onDismissError,
  onRetrySearch,
  downloadSuccess,
  onDismissDownloadSuccess,
  downloadError,
  onDismissDownloadError,
}: SearchNoticesProps) {
  return (
    <>
      {error && (
        <Banner variant="error" onDismiss={onDismissError}>
          <span className="block">{error}</span>
          <button
            type="button"
            className="mt-1 font-medium underline underline-offset-2"
            onClick={onRetrySearch}
          >
            Try again
          </button>
        </Banner>
      )}

      {downloadSuccess && (
        <Banner variant="success" onDismiss={onDismissDownloadSuccess}>
          Added to downloads.{" "}
          <a href="#/downloads" className="font-medium underline underline-offset-2">
            View downloads
          </a>
        </Banner>
      )}

      {downloadError && (
        <Banner variant="error" onDismiss={onDismissDownloadError}>
          {downloadError} — click the download icon to retry.
        </Banner>
      )}
    </>
  );
}
