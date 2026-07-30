let meta = #{
    name: "implement-issues-37-40",
    description: "Serial implement #37-#40 deps inventory; TDD normalize seam; gates; commit",
    when_to_use: "After #36 ticketed into #37-#40 ready-for-agent; implement in order",
    phases: [
        #{ title: "Normalize", detail: "#37 fixture normalize + gitignore + tests" },
        #{ title: "Npm", detail: "#38 web + electron inventory" },
        #{ title: "Python", detail: "#39 clean-resolve Python inventory" },
        #{ title: "Backlog", detail: "#40 scored backlog + entrypoints" },
        #{ title: "Gates", detail: "Full suite, review, commit, close tickets" },
    ],
};

let slice_schema = #{
    "type": "object",
    "required": ["ok", "issue", "summary", "files_changed", "tests_run"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "issue": #{ "type": "integer" },
        "summary": #{ "type": "string" },
        "files_changed": #{ "type": "array", "items": #{ "type": "string" } },
        "tests_run": #{ "type": "string" },
        "blockers": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let gate_schema = #{
    "type": "object",
    "required": ["ok", "summary", "tests", "commit_sha", "closed_issues"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "summary": #{ "type": "string" },
        "tests": #{ "type": "string" },
        "commit_sha": #{ "type": "string" },
        "closed_issues": #{ "type": "array", "items": #{ "type": "integer" } },
        "review_notes": #{ "type": "string" },
        "blockers": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let rules = "";
rules += "San Citro repo. Workspace root. Windows/PowerShell. ";
rules += "Parent https://github.com/rps321321/san-citro/issues/36 ; tickets #37-#40. ";
rules += "Use tools; never invent file contents — read first. ";
rules += "YAGNI; no drive-by refactors; no production dependency version bumps; ";
rules += "no Dependabot/CI fail-on-advisory; no git push; no Co-Authored-By trailers. ";
rules += "Do NOT commit — the final gates agent commits once. Do NOT close GitHub issues (gates does). ";
rules += "TDD at the pre-agreed seam: normalized inventory rows from fixture JSON (no network). ";
rules += "Shell: use ; not &&. Prefer python -m pytest for tests. ";
rules += "Partial work may already exist (scripts/deps_inventory.py, .gitignore .cache/, Makefile, ";
rules += "docs/plans/deps-upgrade-backlog.md) — bring to full AC compliance; do not rewrite blindly. ";
rules += "Return ok=true only if this ticket ACs are met and your focused tests green.\n";

// ---------------------------------------------------------------------------
phase("Normalize");
log("Serial #37 — normalized rows from fixtures");

let p37 = "";
p37 += rules;
p37 += "\n## Ticket #37 — Normalized inventory rows from fixtures\n";
p37 += "AC from gh issue 37:\n";
p37 += "1. Fixture-based tests: severity mapping (Python vulns without severity → ≥ moderate), ";
p37 += "   outdatedness channel/score (patch/minor/major), direct flags, advisory ids, ";
p37 += "   provisional score at effort 1 (score_effort1).\n";
p37 += "2. High-severity fixture rows sort ahead of lower when using build_normalized sort keys.\n";
p37 += "3. .gitignore excludes the deps inventory cache dump directory (.cache/).\n";
p37 += "4. No prod dep bumps; tests need no live registry.\n";
p37 += "Implementation notes:\n";
p37 += "- Prefer importing pure helpers from scripts/deps_inventory.py (build_normalized, ";
p37 += "  _outdatedness, normalize paths) or extract a small testable module if import is hard.\n";
p37 += "- Write tests under tests/ e.g. test_deps_inventory_normalize.py using tmp_path fixtures ";
p37 += "  that write fake web/outdated.json, web/audit.json, python/pip_list.json, python/audit.json ";
p37 += "  and package-meta, then call build_normalized.\n";
p37 += "- TDD: add failing tests first if missing, then make green.\n";
p37 += "Run: python -m pytest tests/test_deps_inventory_normalize.py -q --tb=short\n";
p37 += "Return issue=37.\n";

let r37 = agent(p37, #{
    label: "issue-37",
    capability_mode: "all",
    output_schema: slice_schema,
});

if r37 == () || !r37.success || r37.output == () || r37.output.ok != true {
    let msg = "Issue #37 failed";
    if r37 != () && r37.output != () && r37.output.summary != () {
        msg = r37.output.summary;
    }
    complete(#{ ok: false, failed_phase: "normalize", failed_issue: 37, summary: msg });
}
log("Issue #37 ok: " + r37.output.summary);

// ---------------------------------------------------------------------------
phase("Npm");
log("Serial #38 — npm surfaces inventory");

let p38 = "";
p38 += rules;
p38 += "\n## Ticket #38 — npm surfaces inventory (web + Electron)\n";
p38 += "Blocked by #37 (done). AC from gh issue 38:\n";
p38 += "1. Entrypoint writes meta + per-surface raw outputs for web and electron-app under cache dump.\n";
p38 += "2. Normalized rows include both npm surfaces; direct deps from manifests.\n";
p38 += "3. Non-zero npm outdated/audit exits still succeed when JSON valid.\n";
p38 += "4. Skip flags: web-only skip, electron-only skip, all-npm skip (and --skip-python exists).\n";
p38 += "5. Manual smoke: python scripts/deps_inventory.py --skip-python exits 0 with node_modules present.\n";
p38 += "6. No prod dep version bumps.\n";
p38 += "Implement/complete scripts/deps_inventory.py npm collection if incomplete. ";
p38 += "Smoke may take a minute. Do not run full Python venv in this ticket.\n";
p38 += "Return issue=38.\n";

let r38 = agent(p38, #{
    label: "issue-38",
    capability_mode: "all",
    output_schema: slice_schema,
});

if r38 == () || !r38.success || r38.output == () || r38.output.ok != true {
    let msg = "Issue #38 failed";
    if r38 != () && r38.output != () && r38.output.summary != () {
        msg = r38.output.summary;
    }
    complete(#{ ok: false, failed_phase: "npm", failed_issue: 38, summary: msg });
}
log("Issue #38 ok: " + r38.output.summary);

// ---------------------------------------------------------------------------
phase("Python");
log("Serial #39 — Python clean-resolve inventory");

let p39 = "";
p39 += rules;
p39 += "\n## Ticket #39 — Python clean-resolve inventory\n";
p39 += "Blocked by #37 (done). AC from gh issue 39:\n";
p39 += "1. Collect Python surface without requiring a pre-existing project venv (temp venv + editable install).\n";
p39 += "2. Dump includes pip list, tree, audit, package-meta with declared directs.\n";
p39 += "3. Normalized rows include Python; missing severity → ≥ moderate.\n";
p39 += "4. Temp env cleaned up best-effort after run.\n";
p39 += "5. Do not add pipdeptree/pip-audit to product runtime deps in pyproject.\n";
p39 += "6. --skip-python works for npm-only runs.\n";
p39 += "7. No prod dep version bumps.\n";
p39 += "Smoke: python scripts/deps_inventory.py --skip-web --skip-electron (or full) may take several minutes — run it.\n";
p39 += "Keep #37 tests green. Return issue=39.\n";

let r39 = agent(p39, #{
    label: "issue-39",
    capability_mode: "all",
    output_schema: slice_schema,
});

if r39 == () || !r39.success || r39.output == () || r39.output.ok != true {
    let msg = "Issue #39 failed";
    if r39 != () && r39.output != () && r39.output.summary != () {
        msg = r39.output.summary;
    }
    complete(#{ ok: false, failed_phase: "python", failed_issue: 39, summary: msg });
}
log("Issue #39 ok: " + r39.output.summary);

// ---------------------------------------------------------------------------
phase("Backlog");
log("Serial #40 — scored backlog + entrypoints");

let p40 = "";
p40 += rules;
p40 += "\n## Ticket #40 — Scored backlog document and discoverable entrypoints\n";
p40 += "Blocked by #38 and #39 (done). AC from gh issue 40:\n";
p40 += "1. Committed docs/plans/deps-upgrade-backlog.md with rubric, buckets, high/crit checklist, ";
p40 += "   ranked items with effort/buckets, follow-ups (lockfile, version identity, binaries/vendored).\n";
p40 += "2. Content derived from an actual dump (note generated_at / source).\n";
p40 += "3. Regeneration instructions + Make target and/or documented script entrypoint.\n";
p40 += "4. If Makefile install touched: use pip install -e \".[dev]\" not missing requirements-dev.txt.\n";
p40 += "5. No prod dep bumps; no Dependabot policy.\n";
p40 += "6. Optional: note dead direct deps (epubjs unused vs foliate-js reader).\n";
p40 += "Refresh backlog from latest .cache/deps-inventory if present, or re-run inventory once.\n";
p40 += "Keep normalize tests green. Return issue=40.\n";

let r40 = agent(p40, #{
    label: "issue-40",
    capability_mode: "all",
    output_schema: slice_schema,
});

if r40 == () || !r40.success || r40.output == () || r40.output.ok != true {
    let msg = "Issue #40 failed";
    if r40 != () && r40.output != () && r40.output.summary != () {
        msg = r40.output.summary;
    }
    complete(#{ ok: false, failed_phase: "backlog", failed_issue: 40, summary: msg });
}
log("Issue #40 ok: " + r40.output.summary);

// ---------------------------------------------------------------------------
phase("Gates");
log("Full suite, self-review, single commit, close #37-#40");

let pg = "";
pg += rules;
pg += "\n## Gates agent — finalize deps inventory #37-#40\n";
pg += "1. Run: python -m pytest tests/test_deps_inventory_normalize.py -q --tb=short\n";
pg += "2. Run full Python suite: python -m pytest -q --tb=line (fix only inventory-related failures; ";
pg += "   do not expand scope for unrelated pre-existing reds — report them in blockers if any).\n";
pg += "3. Quick smoke: python scripts/deps_inventory.py --skip-python (npm only) exits 0.\n";
pg += "4. Self-review the uncommitted diff for bugs/security; fix real issues if any.\n";
pg += "5. Stage ONLY inventory-related files: scripts/deps_inventory.py, tests/test_deps_inventory*.py, ";
pg += "   .gitignore, Makefile, docs/plans/deps-upgrade-backlog.md, .grok/workflows/implement-issues-37-40.rhai ";
pg += "   if present. Do NOT stage unrelated docs/plans tickets, AGENTS.md, .grok other stuff, node_modules, .cache.\n";
pg += "6. Commit with a good message (complete sentences, no Co-Authored-By). One commit preferred.\n";
pg += "7. Close issues 37,38,39,40 with a short comment that ACs are met and commit SHA. ";
pg += "   Do not close parent #36 unless all ACs of #36 are clearly satisfied — you may comment on #36.\n";
pg += "8. Do not git push.\n";
pg += "Return ok, tests string, commit_sha, closed_issues list, review_notes.\n";

let rg = agent(pg, #{
    label: "gates-37-40",
    capability_mode: "all",
    output_schema: gate_schema,
});

if rg == () || !rg.success || rg.output == () || rg.output.ok != true {
    let msg = "Gates failed";
    if rg != () && rg.output != () && rg.output.summary != () {
        msg = rg.output.summary;
    }
    complete(#{ ok: false, failed_phase: "gates", summary: msg });
}

complete(#{
    ok: true,
    summary: rg.output.summary,
    tests: rg.output.tests,
    commit_sha: rg.output.commit_sha,
    closed_issues: rg.output.closed_issues,
    review_notes: rg.output.review_notes,
    slices: [37, 38, 39, 40],
});
