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

**Telemetry fact**:
A structured observation captured by a sanctioned emitter, such as user intent, session behavior,
a scrape request, or a download outcome. It becomes a telemetry row only after shared context is added.
_Avoid_: "raw row" for an observation that has not yet been contextualized.

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

## Language — Download Library

**Library**:
The in-app, **DB-driven view** of downloads — grouped/sorted/filtered by author, year,
and category from the SQLite metadata. NOT a physical folder hierarchy (see ADR-0006).
_Avoid_: "library tree", "library folder" (organization is a query, not a directory).

**Library item**:
A completed download represented in the Library. Every Library item shares a core identity and
metadata, then takes one of two variants: **Book** or **Audiobook**, each retaining its own details.
_Avoid_: treating Books and Audiobooks as unrelated collections, or flattening their distinct details.

**Storage location**:
Where a download physically lands: flat and **human-readable** under
`<download dir>/San Citro/` — single books directly (`Title - Author.ext`), audiobooks
under `San Citro/audiobooks/<md5>/`. No author/year folders on disk; the DB indexes
everything by **md5**.

**Category**:
A download's classification — **Books** or **Audiobooks** — stored as a DB attribute
(`downloads.media_type`), decided authoritatively by the backend after download (it
inspects the real file/archive). A *view facet*, not a folder.

**Artifact**:
What a completed download produces: either a **single file** (epub, pdf, m4b, …) or an
**extracted folder** (the unpacked contents of a zip/rar archive at `audiobooks/<md5>/`,
after which the archive is deleted). A download is therefore a file *or* a folder.
_Avoid_: "the downloaded file" (it may be a folder).

**Metadata spine**:
The search-result fields (author, year, extension, content_type, cover_url, …) threaded
from the download click through the IPC/bridge chain and persisted in the `downloads`
table. Today they are dropped at `startDownload`; the library view depends on them.

## Language — UI

**Library view**:
The in-app Library page rendering the [[#Library]] DB view: a **grid/list toggle**, **Books /
Audiobooks** tabs, and **Sort + Filter facets** (author, year, genre, category, format,
language). Sits in the nav alongside (not replacing) History.

**Genre**:
A book's genre(s), enriched **best-effort** post-download from **OpenLibrary** `subjects` (keyless,
the primary), with **Google Books** `categories` as an **opt-in fallback only when the user supplies
their own API key** (Google's key + ~100/day quota is a poor fit for a keyless shipped app). Match by
ISBN first (parsed from the filename — unreliable), title+author fallback; `null` on miss, which is
common. **Decoration, never load-bearing** — AA's coarse **category** (fiction/non-fiction/comic) is
the always-present grouping when enrichment is empty. A Library facet. (Decided 2026-06-29.)

**In-page player**:
The persistent audiobook player — a React component (`InPagePlayer`) in the SPA shell, with its
`<audio>` mounted **outside the router `<Outlet>`** so playback survives route changes (the SPA has
no full reloads). State lives in `PlayerContext`; it owns playback + all player UI and streams
chapters over `san-citro-media://`. See ADR-0013 (Phase 2B retired the ADR-0010 `WebContentsView`).
_Avoid_: "the player page", "player view" (it is an in-page component, not a page or a separate view).

## Language — Visual design (ADR-0011)

**Liquid Glass**:
San Citro's material language — translucent, blurred, layered surfaces evoking Apple's Liquid
Glass. On Windows it is *approximated*: **Mica** at the window level (the sidebar) + CSS
`backdrop-filter` for in-app overlays. There is no true refraction.
_Avoid_: calling any flat/opaque panel "glass".

**Control layer vs Content layer**:
The two-tier rule for where glass goes. The **control layer** (sidebar, toolbars, sheets,
popovers, dropdowns, the expanded player, the status island) floats above and is **glass**;
the **content layer** (lists, cards, the library/reading surface) stays **solid** for legibility.

**Citrus accent**:
The single brand accent — a citrus orange from the logo — used with Apple restraint (active nav,
primary buttons, focus rings, the playing chapter). Not a general fill; glass + grays carry the
rest. _Avoid_: Apple system blue, or multiple accent hues.
