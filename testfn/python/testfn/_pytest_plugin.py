"""Private pytest subprocess protocol: preserve actual node IDs and phase outcomes."""

import json
import os
from pathlib import Path
from typing import Any

import pytest

_collected: list[dict[str, str]] = []
_results: dict[str, dict[str, Any]] = {}


def pytest_collection_finish(session: pytest.Session) -> None:
    _collected.extend(
        {"id": item.nodeid, "file": str(item.path), "name": item.name, "rootdir": str(session.config.rootpath)}
        for item in session.items
    )


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    row = _results.setdefault(
        report.nodeid, {"id": report.nodeid, "status": "passed", "duration": 0.0}
    )
    row["duration"] += report.duration * 1000
    if report.failed:
        row["status"] = "failed"
        row["error"] = {
            "message": f"{report.when} failed",
            "stack": str(report.longrepr),
        }
    elif report.skipped and row["status"] != "failed":
        row["status"] = "skipped"

    if report.when == "teardown":
        with open(os.environ["TESTFN_EVENTS"], "a", encoding="utf-8") as stream:
            stream.write(json.dumps(row) + "\n")


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    Path(os.environ["TESTFN_REPORT"]).write_text(
        json.dumps(
            {
                "collected": _collected,
                "results": list(_results.values()),
                "exitstatus": int(exitstatus),
            }
        ),
        encoding="utf-8",
    )
