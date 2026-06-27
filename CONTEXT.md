# San Citro

A single-user, personal R&D desktop tool (Electron) for searching and downloading
from Anna's Archive. Heavily instrumented so the builder can study his own usage.

## Language — Telemetry

**Emit boundary**:
Which process is allowed to send a telemetry row to Supabase. Two are sanctioned:
the **renderer** (UI/session/intent events) and the **Python bridge** (download &
scrape facts). The Electron main process does not emit.

**Telemetry context**:
The five values the renderer owns and hands to the Python bridge once at startup so
both emitters write correlated, well-formed rows: `device_id`, `session_id`,
`app_version`, Supabase URL, Supabase anon key. Absent context ⇒ the bridge silently
skips emitting.
_Avoid_: "credentials", "config" (those are only part of it).

**Device vs Session**:
**device_id** is a persistent UUID in `localStorage` (one per install).
**session_id** is generated per app launch. Every telemetry row carries both.

**Download lifecycle**:
The states a download moves through: `queued → downloading → completed | failed |
cancelled`. The last three are **terminal**.

**Terminal event**:
The single `download_analytics` row emitted when a download reaches a terminal state,
carrying its outcome (status, duration, avg speed, size, error). One per download.
_Avoid_: "completion event" (failures and cancellations count too).

**Scrape request**:
A single outbound fetch to Anna's Archive to satisfy a search. Tracked in
`scraper_health`. Distinct from a download — a search may issue several.

**Blocked**:
A scrape request rejected by Anna's Archive anti-bot defenses (typically HTTP 403).
The signal the no-VPN Chrome strategy exists to defeat, hence worth measuring.

**Mirror**:
A download host Anna's Archive redirects to. Its domain (`mirror_domain`) and the
**strategy** used to reach it (currently always `chrome`, auto-falling back to direct
HTTP) describe a download's transport.

**Engagement rollup**:
The per-session summary row (`engagement_summary`) of counts derivable from the
granular tables. Kept for query convenience, not because it holds unique data.
