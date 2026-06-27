# Python telemetry: renderer-pushed context + injected fact sinks

The Python bridge emits telemetry (`download_analytics` terminal rows, `scraper_health`)
but owns neither the session identity nor the Supabase credentials, and its richest
facts live in CLI-shared `src/` code that must not depend on Supabase. Two mechanisms
resolve this:

1. **Context handshake.** At startup the renderer calls a new `setTelemetryContext`
   IPC method passing `{device_id, session_id, app_version, supabase_url, anon_key}`.
   The bridge stores it and stamps every row; if it's never set (e.g. CLI, or missing
   creds), the bridge no-ops. The renderer stays the single source of all five values.

2. **Injected fact sinks.** `src/` code surfaces facts through optional callbacks, not
   direct emits: downloads already use `on_status`; scrapes gain an `on_health` sink.
   The bridge supplies a sink that posts to Supabase; the CLI supplies none and stays
   telemetry-free. The Supabase coupling lives only in the bridge layer.

The POST itself uses stdlib `urllib.request` on a daemon thread (fire-and-forget, never
blocks a handler); `curl_cffi`'s TLS-fingerprint evasion is for scraping Anna's Archive,
not for talking to Supabase.

## Consequences

- `scrape_annas_archive` gains an optional `on_health` parameter — a signature change to
  a shared function, but backward-compatible (defaults to None).
- Two emitters share each table's schema; `app_version` is passed *through* the context
  rather than recomputed, so the drift that caused the original 400s can't recur on it.
