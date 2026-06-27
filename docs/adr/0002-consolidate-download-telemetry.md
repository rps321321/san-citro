# download_analytics is the single source for download/mirror telemetry

`mirror_performance` duplicated `download_analytics` in 6 of 8 columns (domain, speed,
time, size, success, error); its only unique fields (`time_to_first_byte_ms`,
`status_code`) are Python-only and low-value for one user. `metrics` was a generic
`name/value/unit` bucket whose every concrete use already had a typed home
(`search_analytics`, `download_analytics`, `bridge_performance`). Both tables were
empty with zero call sites. We dropped them and their emitters; `download_analytics`
is now the one place download and mirror facts live.

## Consequences

- Anyone wanting TTFB or HTTP status on a download adds a nullable column to
  `download_analytics` rather than reviving a parallel table.
- No forever-empty tables remain to re-trigger the "is telemetry broken?" debugging
  trap that empty-but-RLS-hidden tables caused before.
