#!/usr/bin/env python3
"""Diagnose San Citro in-app update path (feed → download → install).

Agent-runnable feedback loop for update-system bugs. Exit codes:
  0 PASS — installed version matches latest release (update applied)
  2 RED  — stall after download: pending installer exists, app still old
  3 RED  — feed/asset contract broken
  4 RED  — installed older than latest, no pending download (check/download failed)
  5 WARN — cannot find install or logs (partial environment)
  1       — usage / unexpected error

Does not install or quit the app. Read-only.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

OWNER = "rps321321"
REPO = "san-citro"
SETUP_RE = re.compile(r"^San-Citro-Setup-(\d+\.\d+\.\d+)\.exe$")


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "san-citro-update-diag"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def _head_len(url: str) -> int | None:
    req = urllib.request.Request(
        url, method="HEAD", headers={"User-Agent": "san-citro-update-diag"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        cl = resp.headers.get("Content-Length")
        return int(cl) if cl else None


def latest_release() -> dict:
    raw = _get(f"https://api.github.com/repos/{OWNER}/{REPO}/releases/latest")
    return json.loads(raw.decode("utf-8"))


def parse_latest_yml(text: str) -> dict[str, str | int | None]:
    version = path = url = None
    size = None
    for line in text.splitlines():
        if m := re.match(r"^version:\s*(.+)$", line):
            version = m.group(1).strip().strip("'\"")
        elif m := re.match(r"^path:\s*(.+)$", line):
            path = m.group(1).strip().strip("'\"")
        elif m := re.match(r"^\s+-\s+url:\s*(.+)$", line):
            url = m.group(1).strip().strip("'\"")
        elif m := re.match(r"^\s+size:\s*(\d+)\s*$", line):
            size = int(m.group(1))
    return {"version": version, "path": path, "url": url, "size": size}


def check_feed(tag: str, version: str) -> list[str]:
    errors: list[str] = []
    base = f"https://github.com/{OWNER}/{REPO}/releases/download/{tag}"
    yml = _get(f"{base}/latest.yml").decode("utf-8")
    fields = parse_latest_yml(yml)
    expected = f"San-Citro-Setup-{version}.exe"
    if fields["version"] != version:
        errors.append(f"latest.yml version={fields['version']!r} expected {version!r}")
    if fields["path"] != expected:
        errors.append(f"latest.yml path={fields['path']!r} expected {expected!r}")
    if fields["url"] != expected:
        errors.append(f"latest.yml url={fields['url']!r} expected {expected!r}")
    try:
        cl = _head_len(f"{base}/{expected}")
        if fields["size"] is not None and cl is not None and cl != fields["size"]:
            errors.append(f"Setup size head={cl} yml={fields['size']}")
        _head_len(f"{base}/{expected}.blockmap")
    except urllib.error.HTTPError as e:
        errors.append(f"asset HEAD failed: {e}")
    return errors


def local_paths() -> dict[str, Path]:
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    roaming = Path(os.environ.get("APPDATA", ""))
    return {
        "exe": local / "Programs" / "San Citro" / "San Citro.exe",
        "pending": local / "san-citro-updater" / "pending",
        "log": roaming / "san-citro" / "logs" / "main.log",
        "app_update": local / "Programs" / "San Citro" / "resources" / "app-update.yml",
    }


def file_version_win(exe: Path) -> str | None:
    if not exe.is_file():
        return None
    try:
        import ctypes
        from ctypes import wintypes

        size = ctypes.windll.version.GetFileVersionInfoSizeW(str(exe), None)
        if not size:
            return None
        buf = ctypes.create_string_buffer(size)
        if not ctypes.windll.version.GetFileVersionInfoW(str(exe), 0, size, buf):
            return None
        p = ctypes.c_void_p()
        l = wintypes.UINT()
        if not ctypes.windll.version.VerQueryValueW(buf, r"\\", ctypes.byref(p), ctypes.byref(l)):
            return None

        class VS_FIXEDFILEINFO(ctypes.Structure):
            _fields_ = [
                ("dwSignature", wintypes.DWORD),
                ("dwStrucVersion", wintypes.DWORD),
                ("dwFileVersionMS", wintypes.DWORD),
                ("dwFileVersionLS", wintypes.DWORD),
                ("dwProductVersionMS", wintypes.DWORD),
                ("dwProductVersionLS", wintypes.DWORD),
                ("dwFileFlagsMask", wintypes.DWORD),
                ("dwFileFlags", wintypes.DWORD),
                ("dwFileOS", wintypes.DWORD),
                ("dwFileType", wintypes.DWORD),
                ("dwFileSubtype", wintypes.DWORD),
                ("dwFileDateMS", wintypes.DWORD),
                ("dwFileDateLS", wintypes.DWORD),
            ]

        info = ctypes.cast(p, ctypes.POINTER(VS_FIXEDFILEINFO)).contents
        major = info.dwFileVersionMS >> 16
        minor = info.dwFileVersionMS & 0xFFFF
        patch = info.dwFileVersionLS >> 16
        return f"{major}.{minor}.{patch}"
    except Exception:
        return None


def pending_setup_version(pending: Path) -> str | None:
    if not pending.is_dir():
        return None
    for p in pending.iterdir():
        m = SETUP_RE.match(p.name)
        if m and p.is_file() and p.stat().st_size > 0:
            return m.group(1)
    return None


def log_mentions_downloaded(log: Path, version: str) -> bool:
    if not log.is_file():
        return False
    text = log.read_text(encoding="utf-8", errors="replace")
    return f"New version {version} has been downloaded" in text


def log_mentions_quit_install_after_download(log: Path, version: str) -> bool:
    if not log.is_file():
        return False
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    saw = False
    for line in lines:
        if f"New version {version} has been downloaded" in line:
            saw = True
            continue
        if saw and re.search(r"quitAndInstall|Install on quit|isUpdateDownloaded", line, re.I):
            return True
    return False


def main() -> int:
    print("=== San Citro update system diag ===")
    try:
        rel = latest_release()
    except Exception as e:
        print(f"FAIL cannot fetch latest release: {e}")
        return 3

    tag = rel.get("tag_name") or ""
    version = tag.lstrip("v")
    print(f"latest_release tag={tag} version={version}")
    if not re.match(r"^\d+\.\d+\.\d+", version):
        print("FAIL bad tag")
        return 3

    feed_errs = check_feed(tag, version)
    if feed_errs:
        for e in feed_errs:
            print(f"FAIL feed: {e}")
        return 3
    print("ok  feed contract (latest.yml + Setup HEAD + blockmap HEAD)")

    paths = local_paths()
    installed = file_version_win(paths["exe"]) if paths["exe"].is_file() else None
    pending_ver = pending_setup_version(paths["pending"])
    print(f"installed_exe={paths['exe']}")
    print(f"installed_version={installed!r}")
    print(f"pending_dir={paths['pending']}")
    print(f"pending_setup_version={pending_ver!r}")
    print(f"log={paths['log']} exists={paths['log'].is_file()}")

    if installed is None and pending_ver is None:
        print("WARN no installed app and no pending update on this machine")
        return 5

    if installed == version:
        print(f"PASS installed version matches latest ({version})")
        return 0

    # installed older (or unknown) vs latest
    if pending_ver == version or log_mentions_downloaded(paths["log"], version):
        qi = log_mentions_quit_install_after_download(paths["log"], version)
        print(
            f"RED stall-after-download: latest={version} installed={installed!r} "
            f"pending={pending_ver!r} quitAndInstall_after_download_logged={qi}"
        )
        print(
            "symptom: electron-updater downloaded the Setup but the running install "
            "is still the old version (install/restart step not completed or not logged)."
        )
        return 2

    print(
        f"RED no-pending: latest={version} installed={installed!r} "
        f"(check/download never completed on this machine)"
    )
    return 4


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR {exc}")
        raise SystemExit(1)
