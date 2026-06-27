# Telemetry is emitted from two boundaries: the renderer and the Python bridge

Telemetry was renderer-only. To capture facts the renderer cannot see — the anti-bot
`blocked` signal on scrapes, and a download's true mirror/strategy/proxy/timing — we
add a second sanctioned emit boundary in the **Python bridge**. The renderer hands the
bridge a **telemetry context** (`device_id`, `session_id`, `app_version`, Supabase URL
+ anon key) via one IPC handshake at startup, so bridge-emitted rows stay correlated
with renderer rows. The bridge posts with stdlib `urllib.request` (no `curl_cffi`) and
no-ops when context is unset.

## Considered options

- **Renderer-only (rejected):** simplest, but the renderer's `DownloadStatus` lacks
  mirror/strategy/proxy and the scraper's `blocked` signal is swallowed inside Python.
  Low-fidelity exactly where the R&D value is.
- **Python-only (rejected):** Python doesn't own `device_id`/`session_id`, so its rows
  would be uncorrelated with the session, and it can't see UI intent events.

## Consequences

- Two emitters now share one schema; schema drift can bite in two places (the
  `app_version` 400 bug was a one-emitter version of this). Mitigated by passing
  `app_version` *through* the context rather than computing it twice.
- Bridge emission lives in the bridge layer (`download_manager`, `handle_search`), not
  in the CLI-shared `src/` core, so the CLI does not gain a Supabase dependency.
