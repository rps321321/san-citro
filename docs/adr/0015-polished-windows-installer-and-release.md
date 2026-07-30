# Polished unsigned Windows Installer + tag-driven Release

San Citro is a single-user personal R&D desktop tool. It already had an electron-builder **NSIS**
Setup and **electron-updater** wired to GitHub; the open question was what “proper polished
installer” means without code signing.

**Decision:**

- **Installer = polished per-user NSIS only (Windows).** Fixed install path (no directory picker);
  Start Menu **and** Desktop shortcuts; finish can launch the app. Wizard chrome is
  commercial-ish: MIT **license** page, **branded** header/sidebar (solid BMPs from logo +
  **Citrus accent**, not Liquid Glass), finish page. **English-only** installer UI (no language
  picker). **No code signing** — SmartScreen “unknown publisher” is accepted.
- **Release = tag `vX.Y.Z` → Windows CI publish.** CI on Windows builds the full pipeline and
  publishes Setup + update feed (`latest.yml` / blockmap) to GitHub Releases with a **stable
  artifact name**. In-app **auto-update** (electron-updater) is the upgrade path after first
  install. App version is the semver without the `v` prefix.
- **Uninstall keeps App state; never deletes Storage location.** Library files under
  `<download dir>/San Citro/` are not owned by the uninstaller. App state (settings, DBs,
  identity) is not wiped on uninstall by default.
- **Out of scope:** macOS/Linux installers, portable-only distribution, multi-locale installer,
  signing, store packaging, nuclear wipe of downloads on uninstall.

## Considered options

- **Unsigned but minimal wizard** — rejected for the polish bar; we still want license + brand art,
  not a bare one-click.
- **Per-machine / Program Files** — rejected: single-user tool; avoid UAC.
- **Manual-only upgrades** — rejected: auto-update is already half-built and is part of “proper.”
- **Manual ad-hoc publish without CI** — rejected: easy to ship broken feed/artifact names; tag CI
  is the release button.
- **Multi-OS CI matrix** — rejected for now: cost without users on those platforms.
- **Signing** — deferred indefinitely for personal/R&D; not a prerequisite for Installer polish.

## Consequences

- electron-builder config must encode per-user, fixed path, both shortcuts, license + NSIS bitmaps,
  and a stable `artifactName` aligned with the update feed.
- A Windows GitHub Actions release workflow must run the full package pipeline on `v*` tags and
  publish assets the updater expects.
- SmartScreen friction remains on first download of each Setup; documentation can say so without
  pretending the app is signed.
- Glossary: **Installer**, **Release**, **App state** (see CONTEXT.md); do not conflate with
  **Storage location**.
