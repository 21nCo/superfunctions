from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_release_gate_dry_run_lists_the_full_repo_root_command_set():
    result = subprocess.run(
        ["node", "browsefn/scripts/verify-release.mjs", "--dry-run"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )

    payload = json.loads(result.stdout.strip().splitlines()[-1])

    assert payload["ok"] is True
    assert payload["dryRun"] is True
    assert payload["releaseGate"] == "browsefn/.conduct/release-gate.md"
    assert payload["commands"][:5] == [
        "npm --prefix browsefn/typescript run build",
        "npm --prefix browsefn/typescript run typecheck",
        "npm --prefix browsefn/typescript run test -- --run",
        "python3 -m compileall browsefn/python/browsefn browsefn/python/tests",
        "python3 -m pytest browsefn/python/tests -q",
    ]
    assert payload["commands"][5].endswith(" browsefn/scripts/check-duplication.mjs")


def test_release_gate_document_matches_the_operator_command_list():
    release_gate = (ROOT / "browsefn" / ".conduct" / "release-gate.md").read_text()

    assert "npm --prefix browsefn/typescript run build" in release_gate
    assert "npm --prefix browsefn/typescript run typecheck" in release_gate
    assert "npm --prefix browsefn/typescript run test -- --run" in release_gate
    assert "python3 -m compileall browsefn/python/browsefn browsefn/python/tests" in release_gate
    assert "python3 -m pytest browsefn/python/tests -q" in release_gate
    assert "npx --yes jscpd@5.4.1 browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console" in release_gate
    assert "node browsefn/scripts/verify-release.mjs" in release_gate
