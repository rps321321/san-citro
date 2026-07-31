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
          Could not complete the search. Check your connection, then{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={onRetrySearch}
          >
            try again
          </button>
          .
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
