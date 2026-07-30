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
The states a **single** download moves through: `queued → downloading → completed |
failed | cancelled`. The last three are **terminal**. Concurrency and the on-screen
list of in-flight jobs are not part of this concept — they are a view over many
lifecycles.
_Avoid_: treating the desktop queue/map as the lifecycle itself; CLI `"success"` as a
lifecycle status (map it to `completed`).

**Terminal event**:
The single `download_analytics` row emitted when a download reaches a terminal state,
carrying its outcome (status, duration, avg speed, size, error, and transport facts
when known — strategy, mirror). One per download; never twice.
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
(`downloads.media_type`), decided **once** by inspecting the real Artifact after bytes
land (archive listing and/or audio extension — never search keywords alone). A *view
facet*, not a folder. Processing may still run for audiobooks; Category is the stamp,
not the processing status.
_Avoid_: stamping `book` from “not a zip”; equating Category with `audiobooks.status`.

**Artifact**:
What a completed download produces: either a **single file** (epub, pdf, m4b, …) or an
**extracted folder** (the unpacked contents of a zip/rar archive at `audiobooks/<md5>/`,
after which the archive is deleted). A download is therefore a file *or* a folder.
_Avoid_: "the downloaded file" (it may be a folder).

**Metadata spine**:
The search-result fields (author, year, extension, content_type, language, publisher,
cover_url, …) threaded from the download click through the IPC/bridge chain and
persisted on the `downloads` row at start. The Library view is fed by these fields
(plus post-download Category), not by re-scraping.
_Avoid_: implying the spine is optional for Library richness; inventing metadata only
on disk paths.

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
The persistent audiobook player in the SPA shell: chrome + transport, with `<audio>` mounted
**outside the router `<Outlet>`** so playback survives route changes (the SPA has no full
reloads). Streams chapters over `san-citro-media://`. See ADR-0013 (Phase 2B retired the
ADR-0010 `WebContentsView`).
_Avoid_: "the player page", "player view" (it is in-page chrome, not a route).

**Playback policy**:
Chapter index, resume position, progress-save cadence, and next-chapter-on-end for an
audiobook session. Distinct from the visual In-page player chrome and from the media protocol.
_Avoid_: burying policy only inside React markup with no testable seam.

**Active downloads**:
The live set of Download lifecycles the UI is watching (progress, cancel, terminal badges).
One session-scoped view over many jobs — not a second status machine and not the Library.
_Avoid_: "SSE stream", separate Maps per page for the same transfers.

**Readable format**:
A Book Artifact extension the in-app reader can open (foliate multi-format set). Distinct from
Category and from “file exists on disk.”
_Avoid_: hardcoding EPUB-only on some surfaces and multi-format on others.

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

## Language — Distribution (ADR-0015)

**Installer**:
The Windows program that first puts San Citro on this machine — a **polished per-user NSIS Setup**
(branded wizard, fixed path, Start Menu + Desktop shortcuts). It is **unsigned** by policy
(SmartScreen may warn). Not a portable folder and not a store package.
_Avoid_: "portable zip", "MSI", "signed build" (signing is explicitly out of scope).

**Release**:
A versioned public drop of the Installer (and update metadata) on **GitHub Releases**, produced by
tagging `vX.Y.Z`. The in-app updater consumes that Release so already-installed copies upgrade
without a manual reinstall ritual.
_Avoid_: ad-hoc unversioned uploads; treating a local `release/` folder alone as the ship surface.

**App state**:
Settings, history DBs, session/device identity, and other Electron profile data that survive
reinstall and **must not** be wiped by the uninstaller by default. Distinct from [[#Storage location]]
(the books on disk under `…/San Citro/`).
_Avoid_: calling download files "app data"; equating uninstall with deleting the Library.
