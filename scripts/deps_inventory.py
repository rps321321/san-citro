#!/usr/bin/env python3
"""Generate a full dependency inventory dump for San Citro.

Surfaces:
  - web/            (npm lockfile tree + outdated + audit)
  - electron-app/   (npm lockfile tree + outdated + audit)
  - python          (fresh temp venv resolve from pyproject.toml + tree + audit)

Writes regenerable JSON under .cache/deps-inventory/ (gitignored).
Does not bump production dependencies. See docs/plans/deps-upgrade-backlog.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import venv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / ".cache" / "deps-inventory"

SEVERITY_RANK = {
    "none": 0,
    "info": 1,
    "low": 2,
    "moderate": 3,
    "medium": 3,
    "high": 4,
    "critical": 5,
}

SEVERITY_SCORE = {
    "none": 1,
    "info": 1,
    "low": 2,
    "moderate": 4,
    "medium": 4,
    "high": 8,
    "critical": 16,
}


def _run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        check=check,
    )


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")


def _parse_json_stdout(proc: subprocess.CompletedProcess[str]) -> Any:
    text = (proc.stdout or "").strip()
    if not text:
        return {
            "error": "empty_stdout",
            "returncode": proc.returncode,
            "stderr": (proc.stderr or "")[:4000],
        }
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        return {
            "error": f"json_decode: {exc}",
            "returncode": proc.returncode,
            "stdout_head": text[:2000],
            "stderr": (proc.stderr or "")[:4000],
        }


def _tool_version(cmd: list[str]) -> str | None:
    try:
        proc = _run(cmd)
        if proc.returncode != 0:
            return None
        return (proc.stdout or proc.stderr or "").strip().splitlines()[0]
    except OSError:
        return None


def _npm_cmd() -> list[str]:
    # On Windows, npm is typically npm.cmd
    if os.name == "nt":
        return ["npm.cmd"]
    return ["npm"]


def collect_npm_surface(name: str, package_dir: Path, out_dir: Path) -> dict[str, Any]:
    surface_out = out_dir / name
    surface_out.mkdir(parents=True, exist_ok=True)
    npm = _npm_cmd()
    summary: dict[str, Any] = {"surface": name, "path": str(package_dir), "commands": {}}

    if not (package_dir / "package.json").exists():
        summary["error"] = "missing package.json"
        return summary

    commands = {
        "tree": npm + ["ls", "--all", "--json"],
        "outdated": npm + ["outdated", "--json"],
        "audit": npm + ["audit", "--json"],
    }
    # npm outdated exits 1 when outdated packages exist; audit may exit non-zero on vulns.
    for key, cmd in commands.items():
        proc = _run(cmd, cwd=package_dir)
        data = _parse_json_stdout(proc)
        _write_json(surface_out / f"{key}.json", data)
        summary["commands"][key] = {
            "returncode": proc.returncode,
            "ok": not (isinstance(data, dict) and data.get("error")),
        }

    # package.json direct deps for "direct?" flag
    pkg = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
    summary["package_version"] = pkg.get("version")
    summary["direct_deps"] = sorted(
        set(pkg.get("dependencies", {})) | set(pkg.get("devDependencies", {}))
    )
    summary["dependencies"] = pkg.get("dependencies", {})
    summary["devDependencies"] = pkg.get("devDependencies", {})
    _write_json(surface_out / "package-meta.json", summary)
    return summary


def _venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def collect_python_surface(out_dir: Path) -> dict[str, Any]:
    surface_out = out_dir / "python"
    surface_out.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {"surface": "python", "path": str(REPO_ROOT / "pyproject.toml")}

    pyproject = REPO_ROOT / "pyproject.toml"
    if not pyproject.exists():
        summary["error"] = "missing pyproject.toml"
        return summary

    # Parse direct deps lightly (no tomllib dependency on older 3.10 — we require 3.11+)
    import tomllib

    with pyproject.open("rb") as f:
        data = tomllib.load(f)
    project = data.get("project", {})
    summary["package_version"] = project.get("version")
    direct = list(project.get("dependencies", []))
    opt = project.get("optional-dependencies", {})
    dev = list(opt.get("dev", []))
    summary["direct_requirements"] = direct
    summary["dev_requirements"] = dev

    def _req_name(req: str) -> str:
        return re.split(r"[<>=!~;\[]", req, maxsplit=1)[0].strip().lower().replace("_", "-")

    summary["direct_deps"] = sorted({_req_name(r) for r in direct + dev if r.strip()})

    tmp = Path(tempfile.mkdtemp(prefix="deps-inventory-py-"))
    summary["temp_venv"] = str(tmp)
    try:
        venv.create(tmp, with_pip=True, clear=True)
        py = _venv_python(tmp)
        if not py.exists():
            summary["error"] = f"venv python missing: {py}"
            return summary

        def pip(*args: str) -> subprocess.CompletedProcess[str]:
            return _run([str(py), "-m", "pip", *args], cwd=REPO_ROOT)

        # Bootstrap pip tooling quietly
        up = pip("install", "--upgrade", "pip", "setuptools", "wheel")
        summary["pip_upgrade_rc"] = up.returncode

        install = pip("install", "-e", ".[dev]")
        summary["install_rc"] = install.returncode
        if install.returncode != 0:
            summary["install_stderr"] = (install.stderr or "")[:4000]
            _write_json(surface_out / "install-error.json", {
                "stdout": install.stdout,
                "stderr": install.stderr,
                "returncode": install.returncode,
            })
            # Continue: still try to capture what we can

        tools = pip("install", "pipdeptree", "pip-audit")
        summary["tools_install_rc"] = tools.returncode
        if tools.returncode != 0:
            summary["tools_stderr"] = (tools.stderr or "")[:2000]

        # pip list
        plist = _run([str(py), "-m", "pip", "list", "--format=json"])
        pip_list = _parse_json_stdout(plist)
        _write_json(surface_out / "pip_list.json", pip_list)

        # pipdeptree JSON
        tree_proc = _run([str(py), "-m", "pipdeptree", "--json"])
        tree = _parse_json_stdout(tree_proc)
        if isinstance(tree, dict) and tree.get("error"):
            # older/newer CLI variants
            tree_proc = _run([str(py), "-m", "pipdeptree", "-j"])
            tree = _parse_json_stdout(tree_proc)
        _write_json(surface_out / "tree.json", tree)
        summary["tree_rc"] = tree_proc.returncode

        # pip-audit JSON (may exit non-zero when vulns found)
        audit_proc = _run([str(py), "-m", "pip_audit", "-f", "json"])
        audit = _parse_json_stdout(audit_proc)
        if isinstance(audit, dict) and audit.get("error"):
            audit_proc = _run([str(py), "-m", "pip_audit", "--format", "json"])
            audit = _parse_json_stdout(audit_proc)
        _write_json(surface_out / "audit.json", audit)
        summary["audit_rc"] = audit_proc.returncode

    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        summary["temp_venv_removed"] = True

    _write_json(surface_out / "package-meta.json", summary)
    return summary


def _max_severity(a: str | None, b: str | None) -> str:
    aa = (a or "none").lower()
    bb = (b or "none").lower()
    return aa if SEVERITY_RANK.get(aa, 0) >= SEVERITY_RANK.get(bb, 0) else bb


def _semver_tuple(version: str | None) -> tuple[int, ...] | None:
    if not version:
        return None
    # strip leading v and pre-release / build
    v = version.strip().lstrip("vV")
    m = re.match(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", v)
    if not m:
        return None
    parts = [int(x) if x is not None else 0 for x in m.groups()]
    return tuple(parts)


def _outdatedness(current: str | None, latest: str | None) -> tuple[int, str]:
    """Return (score 1..8, channel label)."""
    cur = _semver_tuple(current)
    lat = _semver_tuple(latest)
    if cur is None or lat is None:
        if current and latest and current != latest:
            return 2, "unknown-delta"
        return 1, "current-or-unknown"
    if lat <= cur:
        return 1, "current"
    # major / minor / patch
    major_behind = lat[0] - cur[0]
    if major_behind > 0:
        score = min(8, 4 + max(0, major_behind - 1))
        return score, "major"
    if lat[1] > cur[1]:
        return 2, "minor"
    if lat[2] > cur[2]:
        return 1, "patch"
    return 1, "current"


def _normalize_npm(surface: str, out_dir: Path, meta: dict[str, Any]) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    direct = set(meta.get("direct_deps") or [])
    surface_dir = out_dir / surface

    def ensure(name: str) -> dict[str, Any]:
        if name not in rows:
            rows[name] = {
                "name": name,
                "surface": surface,
                "ecosystem": "npm",
                "direct": name in direct,
                "current": None,
                "wanted": None,
                "latest": None,
                "severity": "none",
                "advisories": [],
                "outdatedness": 1,
                "outdated_channel": "current-or-unknown",
                "severity_score": 1,
            }
        return rows[name]

    outdated_path = surface_dir / "outdated.json"
    if outdated_path.exists():
        outdated = json.loads(outdated_path.read_text(encoding="utf-8"))
        if isinstance(outdated, dict) and "error" not in outdated:
            for name, info in outdated.items():
                if not isinstance(info, dict):
                    continue
                row = ensure(name)
                row["current"] = info.get("current")
                row["wanted"] = info.get("wanted")
                row["latest"] = info.get("latest")
                od, ch = _outdatedness(row["current"], row["latest"] or row["wanted"])
                row["outdatedness"] = od
                row["outdated_channel"] = ch

    audit_path = surface_dir / "audit.json"
    if audit_path.exists():
        audit = json.loads(audit_path.read_text(encoding="utf-8"))
        vulns = audit.get("vulnerabilities") if isinstance(audit, dict) else None
        if isinstance(vulns, dict):
            for name, info in vulns.items():
                if not isinstance(info, dict):
                    continue
                row = ensure(name)
                sev = (info.get("severity") or "none").lower()
                row["severity"] = _max_severity(row["severity"], sev)
                row["severity_score"] = SEVERITY_SCORE.get(row["severity"], 1)
                via = info.get("via") or []
                adv_ids: list[str] = []
                if isinstance(via, list):
                    for item in via:
                        if isinstance(item, dict):
                            src = item.get("source")
                            title = item.get("title")
                            if src is not None:
                                adv_ids.append(str(src))
                            elif title:
                                adv_ids.append(str(title)[:80])
                        elif isinstance(item, str):
                            adv_ids.append(item)
                row["advisories"] = sorted(set(row["advisories"] + adv_ids))
                # range / fix hints
                if info.get("range"):
                    row["affected_range"] = info.get("range")
                fix = info.get("fixAvailable")
                if fix is not None:
                    row["fix_available"] = fix
                # version from audit if missing
                if not row["current"] and isinstance(info.get("via"), list):
                    for item in info["via"]:
                        if isinstance(item, dict) and item.get("range"):
                            row["current"] = row["current"] or f"in {item.get('range')}"

    # Ensure direct deps appear even if current
    for name, ver in (meta.get("dependencies") or {}).items():
        row = ensure(name)
        row["direct"] = True
        row["dep_kind"] = "dependencies"
        if row["current"] is None:
            row["current"] = str(ver).lstrip("^~>=<")
    for name, ver in (meta.get("devDependencies") or {}).items():
        row = ensure(name)
        row["direct"] = True
        row["dep_kind"] = "devDependencies"
        if row["current"] is None:
            row["current"] = str(ver).lstrip("^~>=<")

    for row in rows.values():
        row["severity_score"] = SEVERITY_SCORE.get(row["severity"], 1)
        if row.get("latest") or row.get("wanted"):
            od, ch = _outdatedness(row.get("current"), row.get("latest") or row.get("wanted"))
            row["outdatedness"] = od
            row["outdated_channel"] = ch
        # preliminary score without effort (effort=1 placeholder)
        row["score_effort1"] = round(
            (row["severity_score"] * row["outdatedness"]) / 1.0, 3
        )

    return list(rows.values())


def _normalize_python(out_dir: Path, meta: dict[str, Any]) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    direct = set(meta.get("direct_deps") or [])
    surface_dir = out_dir / "python"

    def ensure(name: str) -> dict[str, Any]:
        key = name.lower().replace("_", "-")
        if key not in rows:
            rows[key] = {
                "name": key,
                "surface": "python",
                "ecosystem": "pypi",
                "direct": key in direct,
                "current": None,
                "wanted": None,
                "latest": None,
                "severity": "none",
                "advisories": [],
                "outdatedness": 1,
                "outdated_channel": "current-or-unknown",
                "severity_score": 1,
            }
        return rows[key]

    pip_list_path = surface_dir / "pip_list.json"
    if pip_list_path.exists():
        pip_list = json.loads(pip_list_path.read_text(encoding="utf-8"))
        if isinstance(pip_list, list):
            for item in pip_list:
                if not isinstance(item, dict):
                    continue
                name = item.get("name") or ""
                row = ensure(name)
                row["current"] = item.get("version")

    audit_path = surface_dir / "audit.json"
    if audit_path.exists():
        audit = json.loads(audit_path.read_text(encoding="utf-8"))
        # pip-audit JSON formats vary: list of deps with vulns, or {"dependencies": [...]}
        entries: list[Any]
        if isinstance(audit, list):
            entries = audit
        elif isinstance(audit, dict):
            entries = audit.get("dependencies") or audit.get("vulns") or []
            if isinstance(entries, dict):
                entries = list(entries.values())
        else:
            entries = []

        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("package") or ""
            if not name and "vulns" not in entry:
                continue
            # Format: {"name": "...", "version": "...", "vulns": [...]}
            if name:
                row = ensure(str(name))
                if entry.get("version"):
                    row["current"] = entry.get("version")
                vulns = entry.get("vulns") or entry.get("vulnerabilities") or []
                if isinstance(vulns, list):
                    for v in vulns:
                        if not isinstance(v, dict):
                            continue
                        # pip-audit often omits severity; any listed vuln is at least moderate.
                        raw_sev = v.get("severity")
                        if isinstance(raw_sev, str) and raw_sev.strip():
                            sev = raw_sev.lower()
                        else:
                            sev = "moderate"
                        row["severity"] = _max_severity(row["severity"], sev)
                        for key in ("id", "aliases"):
                            val = v.get(key)
                            if isinstance(val, str):
                                row["advisories"].append(val[:120])
                            elif isinstance(val, list):
                                row["advisories"].extend(str(x) for x in val[:8])
                        fixes = v.get("fix_versions")
                        if fixes:
                            row["fix_versions"] = fixes
            # alternate top-level vuln objects
            elif entry.get("id"):
                pkg = (entry.get("package") or {}).get("name") if isinstance(entry.get("package"), dict) else None
                if pkg:
                    row = ensure(str(pkg))
                    row["severity"] = _max_severity(row["severity"], "moderate")
                    row["advisories"].append(str(entry.get("id")))

    for name in direct:
        ensure(name)

    for row in rows.values():
        row["severity_score"] = SEVERITY_SCORE.get(row["severity"], 1)
        row["advisories"] = sorted(set(row["advisories"]))
        row["score_effort1"] = round(
            (row["severity_score"] * row["outdatedness"]) / 1.0, 3
        )

    return list(rows.values())


def build_normalized(out_dir: Path, metas: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for surface in ("web", "electron-app"):
        info = metas.get(surface)
        if not info or info.get("skipped") or info.get("error"):
            continue
        rows.extend(_normalize_npm(surface, out_dir, info))
    if "python" in metas and not metas["python"].get("skipped") and not metas["python"].get("error"):
        rows.extend(_normalize_python(out_dir, metas["python"]))
    # stable sort: severity desc, outdatedness desc, direct first, name
    rows.sort(
        key=lambda r: (
            -SEVERITY_RANK.get(r.get("severity", "none"), 0),
            -int(r.get("outdatedness") or 0),
            0 if r.get("direct") else 1,
            r.get("surface") or "",
            r.get("name") or "",
        )
    )
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Output directory (default: {DEFAULT_OUT})",
    )
    parser.add_argument("--skip-python", action="store_true")
    parser.add_argument("--skip-npm", action="store_true")
    parser.add_argument(
        "--skip-web",
        action="store_true",
        help="Skip web/ npm surface",
    )
    parser.add_argument(
        "--skip-electron",
        action="store_true",
        help="Skip electron-app/ npm surface",
    )
    args = parser.parse_args(argv)

    out_dir: Path = args.out if args.out.is_absolute() else REPO_ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    meta: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "repo_root": str(REPO_ROOT),
        "python": sys.version,
        "tools": {
            "node": _tool_version(["node", "--version"]),
            "npm": _tool_version(_npm_cmd() + ["--version"]),
            "python": sys.version.split()[0],
        },
        "surfaces": {},
    }

    print(f"Writing inventory to {out_dir}", flush=True)

    if not args.skip_npm:
        if not args.skip_web:
            print("… web (npm)", flush=True)
            meta["surfaces"]["web"] = collect_npm_surface(
                "web", REPO_ROOT / "web", out_dir
            )
        else:
            meta["surfaces"]["web"] = {"skipped": True}
        if not args.skip_electron:
            print("… electron-app (npm)", flush=True)
            meta["surfaces"]["electron-app"] = collect_npm_surface(
                "electron-app", REPO_ROOT / "electron-app", out_dir
            )
        else:
            meta["surfaces"]["electron-app"] = {"skipped": True}
    else:
        meta["surfaces"]["web"] = {"skipped": True}
        meta["surfaces"]["electron-app"] = {"skipped": True}

    if not args.skip_python:
        print("… python (temp venv resolve + audit) — may take several minutes", flush=True)
        meta["surfaces"]["python"] = collect_python_surface(out_dir)
    else:
        meta["surfaces"]["python"] = {"skipped": True}

    print("… normalizing rows", flush=True)
    # Re-load package-meta from disk for complete direct_deps (never overwrite skips)
    for surface, info in list(meta["surfaces"].items()):
        if info.get("skipped"):
            continue
        pkg_meta_path = out_dir / surface / "package-meta.json"
        if pkg_meta_path.exists():
            meta["surfaces"][surface] = json.loads(
                pkg_meta_path.read_text(encoding="utf-8")
            )

    normalized = build_normalized(out_dir, meta["surfaces"])
    _write_json(out_dir / "normalized.json", normalized)
    _write_json(out_dir / "meta.json", meta)

    high_crit = [
        r
        for r in normalized
        if r.get("severity") in ("high", "critical")
    ]
    print(
        f"Done. {len(normalized)} package rows; "
        f"{len(high_crit)} high/critical. "
        f"See {out_dir / 'normalized.json'}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
