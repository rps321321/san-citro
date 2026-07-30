"""Fixture-based tests for deps inventory normalization (no network).

Seam: fake per-surface JSON under tmp_path → build_normalized / _outdatedness.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import deps_inventory as di  # noqa: E402


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _by_name(rows: list[dict[str, Any]], name: str, surface: str | None = None) -> dict[str, Any]:
    matches = [
        r
        for r in rows
        if r.get("name") == name and (surface is None or r.get("surface") == surface)
    ]
    assert matches, f"no row named {name!r} (surface={surface!r}); have {[r.get('name') for r in rows]}"
    assert len(matches) == 1, f"multiple rows for {name!r}: {matches}"
    return matches[0]


# ---------------------------------------------------------------------------
# _outdatedness unit (patch / minor / major / current)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "current,latest,score,channel",
    [
        ("1.2.3", "1.2.4", 1, "patch"),
        ("1.2.3", "1.3.0", 2, "minor"),
        ("1.2.3", "2.0.0", 4, "major"),
        ("1.0.0", "3.0.0", 5, "major"),  # +1 per extra major, base 4
        ("2.0.0", "2.0.0", 1, "current"),
        ("1.0.0", "10.0.0", 8, "major"),  # cap at 8
    ],
)
def test_outdatedness_channels(
    current: str, latest: str, score: int, channel: str
) -> None:
    got_score, got_channel = di._outdatedness(current, latest)
    assert got_score == score
    assert got_channel == channel


# ---------------------------------------------------------------------------
# Fixture layout helpers
# ---------------------------------------------------------------------------


def _web_fixtures(out_dir: Path) -> dict[str, Any]:
    """npm-shaped outdated + audit for web surface."""
    surface = out_dir / "web"
    _write_json(
        surface / "outdated.json",
        {
            "left-pad": {
                "current": "1.0.0",
                "wanted": "1.0.1",
                "latest": "1.0.1",
                "dependent": "app",
                "location": "/node_modules/left-pad",
            },
            "big-major": {
                "current": "1.0.0",
                "wanted": "1.0.0",
                "latest": "3.0.0",
                "dependent": "app",
                "location": "/node_modules/big-major",
            },
            "minor-bump": {
                "current": "2.1.0",
                "wanted": "2.2.0",
                "latest": "2.2.0",
                "dependent": "app",
                "location": "/node_modules/minor-bump",
            },
        },
    )
    _write_json(
        surface / "audit.json",
        {
            "vulnerabilities": {
                "critical-pkg": {
                    "name": "critical-pkg",
                    "severity": "critical",
                    "via": [
                        {
                            "source": 999001,
                            "title": "RCE in critical-pkg",
                            "severity": "critical",
                            "range": "<2.0.0",
                        }
                    ],
                    "range": "<2.0.0",
                    "fixAvailable": True,
                },
                "high-pkg": {
                    "name": "high-pkg",
                    "severity": "high",
                    "via": [
                        {
                            "source": 999002,
                            "title": "DoS high-pkg",
                            "severity": "high",
                        }
                    ],
                    "range": "<1.1.0",
                    "fixAvailable": False,
                },
                "left-pad": {
                    "name": "left-pad",
                    "severity": "low",
                    "via": ["some-transitive"],
                    "range": "<=1.0.0",
                },
            }
        },
    )
    meta = {
        "surface": "web",
        "direct_deps": ["left-pad", "big-major", "minor-bump", "safe-direct"],
        "dependencies": {
            "left-pad": "^1.0.0",
            "big-major": "^1.0.0",
            "safe-direct": "1.2.3",
        },
        "devDependencies": {
            "minor-bump": "^2.1.0",
        },
    }
    _write_json(surface / "package-meta.json", meta)
    return meta


def _python_fixtures(out_dir: Path) -> dict[str, Any]:
    """pip list + pip-audit shaped JSON for python surface."""
    surface = out_dir / "python"
    _write_json(
        surface / "pip_list.json",
        [
            {"name": "requests", "version": "2.32.0"},
            {"name": "tqdm", "version": "4.65.0"},
            {"name": "safe-lib", "version": "1.0.0"},
        ],
    )
    # pip-audit list-of-deps format; one vuln omits severity → must map ≥ moderate
    _write_json(
        surface / "audit.json",
        [
            {
                "name": "requests",
                "version": "2.32.0",
                "vulns": [
                    {
                        "id": "GHSA-test-requests-1",
                        "aliases": ["CVE-2099-0001"],
                        # severity intentionally omitted
                        "fix_versions": ["2.33.0"],
                    }
                ],
            },
            {
                "name": "tqdm",
                "version": "4.65.0",
                "vulns": [
                    {
                        "id": "PYSEC-2024-tqdm",
                        "severity": "high",
                        "aliases": ["CVE-2024-34062"],
                        "fix_versions": ["4.66.3"],
                    }
                ],
            },
        ],
    )
    meta = {
        "surface": "python",
        "direct_deps": ["requests", "tqdm", "safe-lib"],
    }
    _write_json(surface / "package-meta.json", meta)
    return meta


# ---------------------------------------------------------------------------
# Integration: build_normalized from fixtures
# ---------------------------------------------------------------------------


def test_python_missing_severity_is_at_least_moderate(tmp_path: Path) -> None:
    py_meta = _python_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"python": py_meta})
    req = _by_name(rows, "requests", "python")
    assert di.SEVERITY_RANK[req["severity"]] >= di.SEVERITY_RANK["moderate"]
    assert req["severity"] == "moderate"
    assert req["severity_score"] == 4


def test_python_explicit_severity_and_advisory_ids(tmp_path: Path) -> None:
    py_meta = _python_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"python": py_meta})
    tqdm_row = _by_name(rows, "tqdm", "python")
    assert tqdm_row["severity"] == "high"
    assert tqdm_row["severity_score"] == 8
    assert "PYSEC-2024-tqdm" in tqdm_row["advisories"]
    assert "CVE-2024-34062" in tqdm_row["advisories"]
    req = _by_name(rows, "requests", "python")
    assert "GHSA-test-requests-1" in req["advisories"]
    assert "CVE-2099-0001" in req["advisories"]


def test_python_direct_flags(tmp_path: Path) -> None:
    py_meta = _python_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"python": py_meta})
    for name in ("requests", "tqdm", "safe-lib"):
        assert _by_name(rows, name, "python")["direct"] is True


def test_npm_outdatedness_channels_and_scores(tmp_path: Path) -> None:
    web_meta = _web_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"web": web_meta})

    patch_row = _by_name(rows, "left-pad", "web")
    assert patch_row["outdated_channel"] == "patch"
    assert patch_row["outdatedness"] == 1

    minor_row = _by_name(rows, "minor-bump", "web")
    assert minor_row["outdated_channel"] == "minor"
    assert minor_row["outdatedness"] == 2

    major_row = _by_name(rows, "big-major", "web")
    assert major_row["outdated_channel"] == "major"
    assert major_row["outdatedness"] == 5  # 1 → 3 = base 4 + 1


def test_npm_direct_flags_and_advisories(tmp_path: Path) -> None:
    web_meta = _web_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"web": web_meta})

    assert _by_name(rows, "left-pad", "web")["direct"] is True
    assert _by_name(rows, "safe-direct", "web")["direct"] is True

    high = _by_name(rows, "high-pkg", "web")
    assert high["severity"] == "high"
    assert "999002" in high["advisories"]
    assert high["direct"] is False  # not in direct_deps

    crit = _by_name(rows, "critical-pkg", "web")
    assert crit["severity"] == "critical"
    assert "999001" in crit["advisories"]


def test_score_effort1_is_severity_times_outdatedness(tmp_path: Path) -> None:
    web_meta = _web_fixtures(tmp_path)
    py_meta = _python_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"web": web_meta, "python": py_meta})

    for row in rows:
        expected = round(
            (row["severity_score"] * row["outdatedness"]) / 1.0,
            3,
        )
        assert row["score_effort1"] == expected, row

    # known values
    left = _by_name(rows, "left-pad", "web")
    # severity low=2, outdatedness patch=1 → 2
    assert left["severity_score"] == 2
    assert left["outdatedness"] == 1
    assert left["score_effort1"] == 2.0

    tqdm_row = _by_name(rows, "tqdm", "python")
    # high=8 * outdatedness 1 (no latest in python fixtures) → 8
    assert tqdm_row["score_effort1"] == 8.0


def test_high_severity_sorts_ahead_of_lower(tmp_path: Path) -> None:
    web_meta = _web_fixtures(tmp_path)
    py_meta = _python_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"web": web_meta, "python": py_meta})

    severities = [r["severity"] for r in rows]
    ranks = [di.SEVERITY_RANK[s] for s in severities]
    assert ranks == sorted(ranks, reverse=True), severities

    # critical-pkg must appear before high-pkg before moderate/low/none
    names = [r["name"] for r in rows]
    assert names.index("critical-pkg") < names.index("high-pkg")
    assert names.index("high-pkg") < names.index("requests")  # moderate
    assert names.index("tqdm") < names.index("left-pad")  # high before low
    assert names.index("left-pad") < names.index("safe-lib")  # low before none


def _electron_fixtures(out_dir: Path) -> dict[str, Any]:
    """npm-shaped outdated + audit for electron-app surface."""
    surface = out_dir / "electron-app"
    _write_json(
        surface / "outdated.json",
        {
            "electron": {
                "current": "42.0.0",
                "wanted": "42.0.1",
                "latest": "43.0.0",
                "dependent": "san-citro",
                "location": "/node_modules/electron",
            },
        },
    )
    _write_json(
        surface / "audit.json",
        {
            "vulnerabilities": {
                "brace-expansion": {
                    "name": "brace-expansion",
                    "severity": "high",
                    "via": [{"source": 1101234, "title": "ReDoS", "severity": "high"}],
                    "range": "<2.0.2",
                    "fixAvailable": True,
                },
            }
        },
    )
    meta = {
        "surface": "electron-app",
        "direct_deps": ["electron", "electron-builder", "electron-updater"],
        "dependencies": {
            "electron": "^42.0.0",
            "electron-builder": "^25.0.0",
            "electron-updater": "^6.0.0",
        },
        "devDependencies": {},
    }
    _write_json(surface / "package-meta.json", meta)
    return meta


def test_npm_both_surfaces_and_direct_flags(tmp_path: Path) -> None:
    web_meta = _web_fixtures(tmp_path)
    el_meta = _electron_fixtures(tmp_path)
    rows = di.build_normalized(tmp_path, {"web": web_meta, "electron-app": el_meta})

    surfaces = {r["surface"] for r in rows}
    assert "web" in surfaces
    assert "electron-app" in surfaces

    electron = _by_name(rows, "electron", "electron-app")
    assert electron["direct"] is True
    assert electron["ecosystem"] == "npm"
    assert electron["outdated_channel"] == "major"

    builder = _by_name(rows, "electron-builder", "electron-app")
    assert builder["direct"] is True

    transitive = _by_name(rows, "brace-expansion", "electron-app")
    assert transitive["direct"] is False
    assert transitive["severity"] == "high"
    assert "1101234" in transitive["advisories"]


def test_skipped_surfaces_are_excluded_from_normalized(tmp_path: Path) -> None:
    web_meta = _web_fixtures(tmp_path)
    el_meta = _electron_fixtures(tmp_path)
    rows = di.build_normalized(
        tmp_path,
        {
            "web": web_meta,
            "electron-app": {"skipped": True},
            "python": {"skipped": True},
        },
    )
    surfaces = {r["surface"] for r in rows}
    assert surfaces == {"web"}
    # electron fixtures on disk must not leak in when surface is skipped
    assert all(r["name"] != "brace-expansion" for r in rows)
    # el_meta retained only so call site documents intent; not used when skipped
    assert el_meta["surface"] == "electron-app"


def test_main_all_skips_writes_meta(tmp_path: Path) -> None:
    rc = di.main(["--out", str(tmp_path), "--skip-python", "--skip-npm"])
    assert rc == 0
    meta = json.loads((tmp_path / "meta.json").read_text(encoding="utf-8"))
    assert meta["surfaces"]["web"].get("skipped") is True
    assert meta["surfaces"]["electron-app"].get("skipped") is True
    assert meta["surfaces"]["python"].get("skipped") is True
    rows = json.loads((tmp_path / "normalized.json").read_text(encoding="utf-8"))
    assert rows == []


def test_gitignore_excludes_deps_inventory_cache() -> None:
    gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    # regenerable inventory dump lives under .cache/ (see DEFAULT_OUT)
    assert ".cache/" in gitignore
    assert str(di.DEFAULT_OUT).replace("\\", "/").endswith(".cache/deps-inventory")
